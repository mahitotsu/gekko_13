// token-guard が確かめた主張。gekko_11 では Envoy がヘッダー（x-auth-claims）で渡した。gekko_13 では受け口（main.ts）が確かめて、要求に付ける。
// 会話（Thread）には、gekko_11 と同じく、主張を base64url の JSON で持たせる。
export interface Terms {
  type: string;
  kinds: string[];
  maxBenefit: number;
}

export interface Claims {
  sub: string;
  authorization_details?: Terms[];
  [name: string]: unknown;
}

export function claimsOf(header: string | undefined): Claims {
  if (!header) throw new Error("確かめた主張がない");
  return (JSON.parse(Buffer.from(header, "base64url").toString()) as { claims: Claims }).claims;
}

/** 受け口で確かめたトークンと主張。 */
export interface Verified {
  token: string;
  claims: Record<string, unknown>;
}

/** 主張を、会話に持たせる形（base64url の JSON）にする。 */
export const encodeClaims = (claims: Record<string, unknown>) => Buffer.from(JSON.stringify({ claims })).toString("base64url");
