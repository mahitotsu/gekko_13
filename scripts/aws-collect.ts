// AWS の段: プローブの 3 つの役（probe-bff、probe-transfer、probe-ledger）と rogue のログから、結果を 1 つにまとめる。
// aws/run-scenarios.sh が、ホストで呼ぶ（イメージには入れない）。
// 使い方:
//   node scripts/aws-collect.ts scenarios <bff のログ> <transfer のログ> <ledger のログ> <rogue のログ>
//   node scripts/aws-collect.ts soak <bff のログ> <入れ替えのログの一覧>
//     入れ替えのログの一覧は、1 行に「<サービス> <ログストリーム>」。試験の時間の svid_rotated の 1 件が 1 行
// 結果は local/run/ に JSON で書く。期待どおりでなければ、終了コードを 1 にする。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { SERVICES, type Service } from "./target.ts";

type Result = { id: string; title: string; expected: string; actual: string; pass: boolean | "skipped" };

const TD = "gekko13.internal";
const id = (s: string) => `spiffe://${TD}/svc/${s}`;
const outDir = new URL("../local/run/", import.meta.url).pathname;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

/** プローブのログの RESULT の行（JSON）を読む。なければ誤りにする。 */
function resultOf(file: string): { results?: Result[]; [k: string]: unknown } {
  const line = readFileSync(file, "utf8")
    .split("\n")
    .findLast((l) => l.startsWith("RESULT "));
  if (!line) throw new Error(`RESULT の行がない: ${file}`);
  return JSON.parse(line.slice("RESULT ".length));
}

function print(r: Result) {
  const mark = r.pass === "skipped" ? "SKIP" : r.pass ? "PASS" : "FAIL";
  console.log(`${mark} ${r.id} ${r.title}\n     期待: ${r.expected}\n     実際: ${r.actual}`);
}

/**
 * B-1: タスクが 2 つ以上あるサービスで、タスクが 2 つ以上の AZ に分かれたか。
 * placement.txt は 1 行に「サービス タスク AZ 台」。どのサービスも 1 タスク（段 A）なら、判定しない。
 */
function placementResult(file: string | undefined): Result | undefined {
  if (!file || !existsSync(file)) return undefined;
  const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => l.split(" "));
  const azs = Object.fromEntries(SERVICES.map((s) => [s, rows.filter((r) => r[0] === s).map((r) => r[2])]));
  if (!SERVICES.some((s) => azs[s].length >= 2)) return undefined;
  const spread = SERVICES.filter((s) => azs[s].length >= 2).every((s) => new Set(azs[s]).size >= 2);
  return {
    id: "B-1",
    title: "2 つの AZ の台に、各サービスのタスクが分かれて置かれる",
    expected: "タスクが 2 つ以上あるサービスは、どれも 2 つ以上の AZ にいる",
    actual: SERVICES.map((s) => `${s}: ${azs[s].join(", ") || "(なし)"}`).join(" / "),
    pass: spread,
  };
}

function scenarios(files: string[]) {
  const [bffLog, transferLog, ledgerLog, rogueLog, placementFile] = files;
  const byRole: Record<Service, Result[]> = {
    bff: resultOf(bffLog).results ?? [],
    transfer: resultOf(transferLog).results ?? [],
    ledger: resultOf(ledgerLog).results ?? [],
  };

  // 1-a: 3 つの役が、それぞれ自分のファミリーの ID を得た
  const own = SERVICES.map((s) => byRole[s].find((r) => r.id === "1-a"));
  const a: Result = {
    id: "1-a",
    title: "登録したファミリーごとに、別の SPIFFE ID が配られる（3 つの役のタスクが、それぞれ自分の SVID を得た）",
    expected: SERVICES.map(id).join(", "),
    actual: own.map((r) => r?.actual ?? "(結果なし)").join(", "),
    pass: own.every((r) => r?.pass === true),
  };

  // 1-b: rogue の確認役が、30 秒待っても SVID がないことを出した
  const rogue = /^ROGUE_RESULT (\S+)/m.exec(readFileSync(rogueLog, "utf8"))?.[1];
  const b: Result = {
    id: "1-b",
    title: "登録していないファミリーのタスク（ECS で起動した gekko13-rogue）",
    expected: "30 秒待っても SVID が出ない",
    actual: rogue === "none" ? "SVID なし" : rogue === "svid" ? "SVID が出た" : "(結果なし)",
    pass: rogue === "none",
  };
  const c: Result = { id: "1-c", title: "ホストで docker run にラベルを偽って付けたコンテナ", expected: "AWS では行わない（ホストのシェルが要る）", actual: "未実施", pass: "skipped" };

  const rest = [...byRole.bff, ...byRole.transfer, ...byRole.ledger]
    .filter((r) => r.id !== "1-a")
    .sort((x, y) => x.id.localeCompare(y.id, "en", { numeric: true }));
  const b1 = placementResult(placementFile);
  const results = [a, b, c, ...rest, ...(b1 ? [b1] : [])];
  results.forEach(print);

  const graded = results.filter((r) => r.pass !== "skipped");
  const failed = graded.filter((r) => !r.pass);
  const out = `${outDir}scenarios-aws-${stamp}.json`;
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), target: "aws", results }, null, 2));
  console.log(`記録: ${out}`);
  console.log(`\n${graded.length - failed.length}/${graded.length} 件が期待どおり（対象外 ${results.length - graded.length} 件）。`);
  return failed.length === 0;
}

type SoakResult = { ok?: number; failed?: number; failures?: unknown[]; started?: string; ended?: string };

/**
 * 入れ替えの回数。サービスごとに、タスク（ログストリーム）のうち一番少ない回数を採る（各タスクで 10 回以上が基準）。
 * タスクごとの回数も返す。rotations.txt は、svid_rotated の 1 件が「<サービス> <ログストリーム>」の 1 行。
 */
function rotationsOf(rotationsFile: string) {
  const perTask: Record<string, number> = {};
  for (const line of readFileSync(rotationsFile, "utf8").split("\n").filter(Boolean)) perTask[line] = (perTask[line] ?? 0) + 1;
  const rotations = Object.fromEntries(
    SERVICES.map((s) => {
      const counts = Object.entries(perTask).filter(([k]) => k.startsWith(`${s} `)).map(([, n]) => n);
      return [s, counts.length ? Math.min(...counts) : 0];
    }),
  ) as Record<Service, number>;
  return { rotations, perTask };
}

function soakSummary(bffLog: string, rotationsFile: string) {
  const r = resultOf(bffLog) as SoakResult;
  const { rotations, perTask } = rotationsOf(rotationsFile);
  const tasks = (s: Service) => Object.keys(perTask).filter((k) => k.startsWith(`${s} `)).length;
  const line = `成功 ${r.ok} 回、失敗 ${r.failed} 件。入れ替え ${SERVICES.map((s) => `${s} ${rotations[s]} 回（${tasks(s)} タスクの最少）`).join("、")}（10 回以上が基準）。`;
  const summary = { target: "aws", started: r.started, ended: r.ended, ok: r.ok, failed: r.failed, rotations, rotationsPerTask: perTask, failures: r.failures };
  return { r, rotations, summary, line };
}

function soak(files: string[]) {
  const [bffLog, rotationsFile] = files;
  const { r, rotations, summary, line } = soakSummary(bffLog, rotationsFile);
  const out = `${outDir}soak-aws-${stamp}.json`;
  writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(`記録: ${out}`);
  console.log(`RESULT ${JSON.stringify(summary)}`);
  console.log(`\n${line}`);
  return r.failed === 0 && SERVICES.every((s) => rotations[s] >= 10);
}

/** 「ミリ秒<TAB>メッセージ」の行から、条件に合う最初（または最後）の行を返す。 */
function timedLines(file: string) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => ({ ms: Number(l.slice(0, l.indexOf("\t"))), msg: l.slice(l.indexOf("\t") + 1) }));
}
const authorityOf = (msg: string) => /msg="X509 CA activated".*local_authority_id=(\w+)/.exec(msg)?.[1];

/**
 * B-4: 入れ替えの試験の途中で、SPIRE server を別の AZ（なければ別の台）に移した。
 * 予測: CA の識別子は変わらない。server が SVID の有効期限（5 分）の中で起き直せば、連鎖の失敗は 0 件。
 */
function failover(files: string[]) {
  const [dir] = files;
  const kv = Object.fromEntries(
    readFileSync(`${dir}/failover.txt`, "utf8")
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  const { r, summary, line } = soakSummary(`${dir}/probe-bff.log`, `${dir}/rotations.txt`);

  const oldCa = timedLines(`${dir}/server-old.log`).map((e) => authorityOf(e.msg)).filter(Boolean).at(-1);
  const newCa = timedLines(`${dir}/server-new.log`).map((e) => authorityOf(e.msg)).filter(Boolean)[0];
  const healthyMs = timedLines(`${dir}/registrar-new.log`).find((e) => e.msg.includes("server is healthy"))?.ms;
  const stoppedMs = Date.parse(kv.old_stopped_at ?? "");
  const requestedMs = Number(kv.requested_at_ms);
  const downS = healthyMs && !Number.isNaN(stoppedMs) ? Math.round((healthyMs - stoppedMs) / 1000) : undefined;
  const sinceRequestS = healthyMs && requestedMs ? Math.round((healthyMs - requestedMs) / 1000) : undefined;
  const [startMs, endMs] = [Number(kv.start_ms), Number(kv.end_ms)];
  const agentsStopped = readFileSync(`${dir}/agents-stopped.txt`, "utf8")
    .split("\n")
    .filter(Boolean)
    .filter((l) => {
      const t = Date.parse(l.split("\t")[0]);
      return t >= startMs && t <= endMs;
    }).length;

  const caSame = !!oldCa && oldCa === newCa;
  const pass = caSame && r.failed === 0;
  const b4: Result = {
    id: "B-4",
    title: "連鎖を呼び続けながら、SPIRE server を別の台（できれば別の AZ）で起き直させる",
    expected: "CA の識別子が変わらない。連鎖の失敗 0 件",
    actual:
      `移し先 ${kv.kind === "az" ? "別の AZ" : "別の台（同じ AZ）"}（${kv.old_az} → ${kv.new_az}）。` +
      `CA ${oldCa ?? "(不明)"} → ${newCa ?? "(不明)"}。` +
      `server がいなかった時間 ${downS ?? "(不明)"} 秒（入れ替えを求めてから ${sinceRequestS ?? "(不明)"} 秒）。` +
      `止まった agent ${agentsStopped} 個。連鎖の失敗 ${r.failed} 件`,
    pass,
  };
  print(b4);
  const out = `${outDir}failover-aws-${stamp}.json`;
  writeFileSync(
    out,
    JSON.stringify({ ...summary, failover: { ...kv, oldCa, newCa, healthyMs, downSeconds: downS, sinceRequestSeconds: sinceRequestS, agentsStopped }, b4 }, null, 2),
  );
  console.log(`記録: ${out}`);
  console.log(`\n${line}`);
  console.log(`B-4 は${pass ? "予測どおり" : "予測と違う"}。入れ替えの回数は参考（B-3 は soak で判定する）。`);
  return pass;
}

mkdirSync(outDir, { recursive: true });
const [mode, ...files] = process.argv.slice(2);
const modes: Record<string, (f: string[]) => boolean> = { scenarios, soak, failover };
const ok = modes[mode] ? modes[mode](files) : (console.error("scenarios、soak、failover のどれかを渡す"), false);
process.exit(ok ? 0 : 1);
