// AWS の段: プローブの 3 つの役（probe-bff、probe-transfer、probe-ledger）と rogue のログから、結果を 1 つにまとめる。
// aws/run-scenarios.sh が、ホストで呼ぶ（イメージには入れない）。
// 使い方:
//   node scripts/aws-collect.ts scenarios <bff のログ> <transfer のログ> <ledger のログ> <rogue のログ>
//   node scripts/aws-collect.ts soak <bff のログ> <入れ替えのログの一覧>
//     入れ替えのログの一覧は、1 行に「<サービス> <ログストリーム>」。試験の時間の svid_rotated の 1 件が 1 行
// 結果は local/run/ に JSON で書く。期待どおりでなければ、終了コードを 1 にする。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

function scenarios(files: string[]) {
  const [bffLog, transferLog, ledgerLog, rogueLog] = files;
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
  const results = [a, b, c, ...rest];
  results.forEach(print);

  const graded = results.filter((r) => r.pass !== "skipped");
  const failed = graded.filter((r) => !r.pass);
  const out = `${outDir}scenarios-aws-${stamp}.json`;
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), target: "aws", results }, null, 2));
  console.log(`記録: ${out}`);
  console.log(`\n${graded.length - failed.length}/${graded.length} 件が期待どおり（対象外 ${results.length - graded.length} 件）。`);
  return failed.length === 0;
}

/** 入れ替えの回数は、サービスごとに、タスク（ログストリーム）のうち少ないほうを採る。 */
function soak(files: string[]) {
  const [bffLog, rotationsFile] = files;
  const r = resultOf(bffLog) as { ok?: number; failed?: number; failures?: unknown[]; started?: string; ended?: string };
  const perStream = new Map<string, number>();
  for (const line of readFileSync(rotationsFile, "utf8").split("\n").filter(Boolean)) {
    perStream.set(line, (perStream.get(line) ?? 0) + 1);
  }
  const rotations = Object.fromEntries(
    SERVICES.map((s) => {
      const counts = [...perStream].filter(([k]) => k.startsWith(`${s} `)).map(([, n]) => n);
      return [s, counts.length ? Math.min(...counts) : 0];
    }),
  );
  const summary = { target: "aws", started: r.started, ended: r.ended, ok: r.ok, failed: r.failed, rotations, failures: r.failures };
  const out = `${outDir}soak-aws-${stamp}.json`;
  writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(`記録: ${out}`);
  console.log(`RESULT ${JSON.stringify(summary)}`);
  const enough = SERVICES.every((s) => rotations[s] >= 10);
  console.log(`\n成功 ${r.ok} 回、失敗 ${r.failed} 件。入れ替え ${SERVICES.map((s) => `${s} ${rotations[s]} 回`).join("、")}（10 回以上が基準）。`);
  return r.failed === 0 && enough;
}

mkdirSync(outDir, { recursive: true });
const [mode, ...files] = process.argv.slice(2);
const ok = mode === "scenarios" ? scenarios(files) : mode === "soak" ? soak(files) : (console.error("scenarios か soak を渡す"), false);
process.exit(ok ? 0 : 1);
