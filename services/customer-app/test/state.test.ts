import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { memoryState, sealer } from "../src/state.ts";

// 状態の置き場所（段 D の D1-a3。判断 53、54）。暗号化と、2 つのタスクで共有するときの約束（1 回だけ渡す、ロックで順に更新する）。
describe("セッションの暗号化", () => {
  const key = randomBytes(32).toString("hex");

  it("付加データが同じなら復号できる", () => {
    const box = sealer(key);
    expect(box.open("session:a", box.seal("session:a", "秘密"))).toBe("秘密");
  });

  it("別のキーの行へ写した暗号文は、復号できない", () => {
    const box = sealer(key);
    expect(() => box.open("session:b", box.seal("session:a", "秘密"))).toThrow();
  });

  it("別の暗号鍵では、復号できない", () => {
    const sealed = sealer(key).seal("session:a", "秘密");
    expect(() => sealer(randomBytes(32).toString("hex")).open("session:a", sealed)).toThrow();
  });

  it("暗号鍵が 32 バイトでなければ、使わない", () => {
    expect(() => sealer("00")).toThrow();
  });
});

describe("状態の置き場所（メモリの実装）", () => {
  it("ログインの途中の情報は、1 回だけ渡す", async () => {
    const s = memoryState();
    await s.put("login", "x", "途中", Date.now() + 60_000);
    expect(await Promise.all([s.take("login", "x"), s.take("login", "x")])).toEqual(["途中", undefined]);
  });

  it("期限を過ぎたものは、読めない", async () => {
    const s = memoryState();
    await s.put("session", "x", "古い", Date.now() - 1);
    expect(await s.get("session", "x")).toBeUndefined();
  });

  it("同じ件の更新は、ロックで順に行い、後の更新は先の結果を読む", async () => {
    const s = memoryState();
    await s.put("session", "x", "0", Date.now() + 60_000);
    const bump = () =>
      s.locked("session", "x", async (v) => {
        await new Promise((r) => setTimeout(r, 5));
        const next = String(Number(v) + 1);
        return { value: next, result: next };
      });
    expect(await Promise.all([bump(), bump(), bump()])).toEqual(["1", "2", "3"]);
  });

  it("受信箱は、届いた順に返す", async () => {
    const s = memoryState();
    await s.addNotice("box", "1");
    await s.addNotice("box", "2");
    expect(await s.notices("box")).toEqual(["1", "2"]);
  });
});
