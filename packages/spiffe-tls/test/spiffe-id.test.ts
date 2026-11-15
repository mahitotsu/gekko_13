import { describe, expect, it } from "vitest";
import { spiffeIdOf } from "../src/index.ts";

describe("spiffeIdOf", () => {
  it("URI の SAN を 1 つ取り出す", () => {
    expect(spiffeIdOf("URI:spiffe://gekko13.internal/svc/bff")).toBe("spiffe://gekko13.internal/svc/bff");
  });

  it("DNS の SAN と並んでいても取り出す", () => {
    expect(spiffeIdOf("DNS:bff, URI:spiffe://gekko13.internal/svc/bff")).toBe("spiffe://gekko13.internal/svc/bff");
  });

  it("SPIFFE ID が 2 つあれば、どちらも採らない", () => {
    expect(spiffeIdOf("URI:spiffe://a/x, URI:spiffe://a/y")).toBeUndefined();
  });

  it("SAN がなければ undefined", () => {
    expect(spiffeIdOf(undefined)).toBeUndefined();
    expect(spiffeIdOf("DNS:bff")).toBeUndefined();
  });
});
