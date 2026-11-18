// 段 C の C-1 の確認用のサービス。CloudFront から台の上のサービスに届くかを確かめる。
// 受けた要求のパスと、どのタスク・AZ で受けたか、CloudFront を通ったか（Via と X-Amz-Cf-Id）を JSON で返すだけ。
// 平文の HTTP で受ける（CloudFront から送り先へは HTTP にする。plan.md の C-1）。ECS ではホストポート 8080 に固定する。
import { createServer } from "node:http";
import { hostname } from "node:os";
import { json } from "../../../packages/spiffe-tls/src/index.ts";
import { log } from "../../_shared/src/env.ts";

const PORT = Number(process.env.PORT ?? 8080);

/** ECS のタスクのメタデータ（エンドポイント v4）から、タスクの ID と AZ を読む。ECS の外では空にする。 */
async function taskInfo(): Promise<{ task?: string; az?: string }> {
  const base = process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (!base) return {};
  try {
    const r = (await (await fetch(`${base}/task`)).json()) as { TaskARN?: string; AvailabilityZone?: string };
    return { task: r.TaskARN?.split("/").pop(), az: r.AvailabilityZone };
  } catch {
    return {};
  }
}

const me = await taskInfo();

createServer((req, res) => {
  const viaCloudFront = typeof req.headers["x-amz-cf-id"] === "string";
  log({ event: "request", path: req.url, via_cloudfront: viaCloudFront, remote: req.socket.remoteAddress });
  json(res, 200, {
    service: "edge-check",
    path: req.url,
    task: me.task ?? null,
    az: me.az ?? null,
    container: hostname(),
    via_cloudfront: viaCloudFront,
    via: req.headers.via ?? null,
    remote: req.socket.remoteAddress ?? null,
  });
}).listen(PORT, "::", () => log({ event: "listening", port: PORT }));
