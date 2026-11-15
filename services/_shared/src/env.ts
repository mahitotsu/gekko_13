// サービスの設定を環境変数から読む。足りなければ起動しない。
export function env(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error(`環境変数 ${name} がない`);
  return v;
}

export const log = (o: object) => console.log(JSON.stringify({ at: new Date().toISOString(), svc: process.env.SERVICE, ...o }));
