package main

// 記録の出どころ（段 D の D1-a2-3。gekko_11 の ClusterRecords は Loki から読んだ）。
//   - AWS: CloudWatch Logs のロググループを、文字列で探す（FilterLogEvents）。書いた者は、ログストリームの名前
//     （<ファミリーの接頭辞>/<コンテナ名>/<タスク>）で決める。タスクのロールで読む。デュアルスタックの名前で呼ぶ（IPv6 だけの基盤）。
//   - 手元: docker のソケットから、ラベル gekko13=1 のコンテナのログを読む。書いた者は、ECS と同じ名前のラベル
//     （ファミリー gekko13-<名前>、コンテナ名）で決める。手元の確かめだけに使い、AWS には docker のソケットを渡さない。
//   - 保険会社のシステムの自己申告（/audit/records）は、どちらも SVID の mTLS で、相手の SPIFFE ID を確かめて呼ぶ。

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatchlogs"
)

// retention は、遡る期間。ロググループの保持期間より長くは残らない。
const retention = 7 * 24 * time.Hour

// parseAudit は、ログの 1 行から監査の記録（"audit" の欄）を取り出す。監査の記録でなければ nil。
func parseAudit(line string) map[string]any {
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "{") || !strings.Contains(line, `"audit"`) {
		return nil
	}
	var wrap struct {
		Audit map[string]any `json:"audit"`
	}
	if json.Unmarshal([]byte(line), &wrap) != nil {
		return nil
	}
	return wrap.Audit
}

// Records は、監査の記録（Logs か docker）と、保険会社のシステムの自己申告を合わせた出どころ。
type Records struct {
	logs       func(needle string) ([]Entry, error)
	selfURL    string
	selfClient *http.Client
}

func (r Records) Search(needle string) ([]Entry, error) { return r.logs(needle) }

func (r Records) Contracts() ([]Entry, error) {
	found, err := r.logs("contract")
	if err != nil {
		return nil, err
	}
	var out []Entry
	for _, e := range found {
		if e.Kind() == "contract" {
			out = append(out, e)
		}
	}
	return out, nil
}

func (r Records) SelfReported() ([]map[string]any, error) {
	res, err := r.selfClient.Get(r.selfURL)
	if err != nil {
		return nil, fmt.Errorf("保険会社のシステムの自己申告を読めない: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("保険会社のシステムの自己申告を読めない: %s", res.Status)
	}
	var body struct {
		Contracts []map[string]any `json:"contracts"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return nil, err
	}
	return body.Contracts, nil
}

// CloudWatchLogs は、ロググループを文字列で探す。
func CloudWatchLogs(ctx context.Context, group string) (func(string) ([]Entry, error), error) {
	cfg, err := config.LoadDefaultConfig(ctx, config.WithUseDualStackEndpoint(aws.DualStackEndpointStateEnabled))
	if err != nil {
		return nil, err
	}
	client := cloudwatchlogs.NewFromConfig(cfg)
	return func(needle string) ([]Entry, error) {
		var out []Entry
		pattern := fmt.Sprintf("%q", needle)
		p := cloudwatchlogs.NewFilterLogEventsPaginator(client, &cloudwatchlogs.FilterLogEventsInput{
			LogGroupName:  aws.String(group),
			FilterPattern: aws.String(pattern),
			StartTime:     aws.Int64(time.Now().Add(-retention).UnixMilli()),
		})
		for p.HasMorePages() {
			page, err := p.NextPage(ctx)
			if err != nil {
				return nil, fmt.Errorf("CloudWatch Logs を読めない: %w", err)
			}
			for _, ev := range page.Events {
				rec := parseAudit(aws.ToString(ev.Message))
				if rec == nil {
					continue
				}
				// ログストリームの名前: <ファミリーの接頭辞>/<コンテナ名>/<タスク>
				parts := strings.SplitN(aws.ToString(ev.LogStreamName), "/", 3)
				if len(parts) < 2 {
					continue
				}
				out = append(out, Entry{App: parts[0], Container: parts[1], At: aws.ToInt64(ev.Timestamp), Record: rec})
			}
		}
		return out, nil
	}, nil
}

// DockerLogs は、手元の docker のソケットから、ラベル gekko13=1 のコンテナのログを読む。
func DockerLogs(socket string) func(string) ([]Entry, error) {
	client := &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		},
	}}
	get := func(path string) ([]byte, error) {
		res, err := client.Get("http://docker" + path)
		if err != nil {
			return nil, err
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("docker: %s %s", path, res.Status)
		}
		return io.ReadAll(res.Body)
	}
	return func(needle string) ([]Entry, error) {
		raw, err := get("/containers/json?filters=" + url.QueryEscape(`{"label":["gekko13=1"]}`))
		if err != nil {
			return nil, err
		}
		var containers []struct {
			ID     string            `json:"Id"`
			Labels map[string]string `json:"Labels"`
		}
		if err := json.Unmarshal(raw, &containers); err != nil {
			return nil, err
		}
		var out []Entry
		for _, c := range containers {
			family := strings.TrimPrefix(c.Labels["com.amazonaws.ecs.task-definition-family"], "gekko13-")
			container := c.Labels["com.amazonaws.ecs.container-name"]
			if family == "" || container == "" {
				continue
			}
			logs, err := get(fmt.Sprintf("/containers/%s/logs?stdout=1&stderr=0&timestamps=1&since=%d", c.ID, time.Now().Add(-retention).Unix()))
			if err != nil {
				return nil, err
			}
			for _, line := range demux(logs) {
				ts, msg, _ := strings.Cut(line, " ")
				if !strings.Contains(msg, needle) {
					continue
				}
				if rec := parseAudit(msg); rec != nil {
					at, _ := time.Parse(time.RFC3339Nano, ts)
					out = append(out, Entry{App: family, Container: container, At: at.UnixMilli(), Record: rec})
				}
			}
		}
		return out, nil
	}
}

// demux は、docker のログの多重化（8 バイトの頭と本文の繰り返し。TTY でないコンテナ）を、行に戻す。
func demux(raw []byte) []string {
	var buf bytes.Buffer
	for len(raw) >= 8 {
		n := int(binary.BigEndian.Uint32(raw[4:8]))
		if 8+n > len(raw) {
			break
		}
		buf.Write(raw[8 : 8+n])
		raw = raw[8+n:]
	}
	var lines []string
	sc := bufio.NewScanner(&buf)
	sc.Buffer(make([]byte, 1024*1024), 4*1024*1024)
	for sc.Scan() {
		lines = append(lines, sc.Text())
	}
	return lines
}
