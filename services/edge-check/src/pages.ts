// パスキーの試しの画面（段 C の C-2）。スクリプトは画面に書き込み、外のファイルを読まない。
// options と応答の base64url の変換は、ここで書く（ブラウザーの parse*FromJSON に頼らない）。

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const common = `
const b64 = {
  toBuf: (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)),
  fromBuf: (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, ""),
};
const out = document.getElementById("out");
const show = (label, o) => { out.textContent = label + "\\n" + JSON.stringify(o, null, 2); };
const browser = navigator.userAgent;
async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, browser }) });
  return { status: r.status, body: await r.json() };
}
const ids = (list) => (list || []).map((c) => ({ ...c, id: b64.toBuf(c.id) }));
`;

const shell = (title: string, main: string, script: string) => `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem auto;max-width:44rem;padding:0 1rem;line-height:1.6}
button{font-size:1rem;padding:.5rem 1rem;margin:.25rem .5rem .25rem 0}pre{background:#f4f4f4;padding:1rem;white-space:pre-wrap;word-break:break-all}
@media (prefers-color-scheme: dark){body{background:#111;color:#eee}pre{background:#222}}</style></head>
<body>${main}<pre id="out">（結果がここに出る）</pre><script>${common}${script}</script></body></html>`;

/** C2-1 と C2-4: ログインサーバーの役（/login/）。パスキーを登録する。 */
export function loginPage(): string {
  return shell(
    "gekko13 login",
    `<h1>ログインサーバーの役（/login/）</h1>
<p>この配信の名前を RP ID にして、パスキーを登録します（C2-1）。登録したら、<a href="/app/">顧客のアプリの役（/app/）</a>で署名します。</p>
<button id="reg">パスキーを登録する（C2-1）</button>
<button id="bad">RP ID を cloudfront.net にして登録を求める（C2-4。拒まれるはず）</button>`,
    `
async function register(suffix) {
  const kase = suffix ? "C2-4" : "C2-1";
  const o = await post("/login/api/register/options", { suffix });
  const opt = o.body.options;
  try {
    const cred = await navigator.credentials.create({ publicKey: {
      ...opt,
      challenge: b64.toBuf(opt.challenge),
      user: { ...opt.user, id: b64.toBuf(opt.user.id) },
      excludeCredentials: ids(opt.excludeCredentials),
    } });
    const r = cred.response;
    const response = {
      id: cred.id, rawId: b64.fromBuf(cred.rawId), type: cred.type,
      authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
      clientExtensionResults: cred.getClientExtensionResults(),
      response: {
        clientDataJSON: b64.fromBuf(r.clientDataJSON),
        attestationObject: b64.fromBuf(r.attestationObject),
        transports: r.getTransports ? r.getTransports() : [],
      },
    };
    show(kase + " サーバーの検証", await post("/login/api/register/verify", { flow: o.body.flow, response }));
  } catch (e) {
    await post("/login/api/register/client-error", { case: kase, name: e.name, message: e.message });
    show(kase + " ブラウザーが拒んだ", { rp_id: opt.rp.id, name: e.name, message: e.message });
  }
}
document.getElementById("reg").onclick = () => register(false);
document.getElementById("bad").onclick = () => register(true);
`,
  );
}

/** C2-2: 顧客のアプリの役（/app/）。文書のハッシュを challenge にして署名する。 */
export function appPage(document: string, hash: string): string {
  return shell(
    "gekko13 app",
    `<h1>顧客のアプリの役（/app/）</h1>
<p>次の文書の SHA-256 を challenge にして、<a href="/login/">/login/</a> で登録したパスキーで署名します（C2-2）。</p>
<p>文書: <code>${escape(document)}</code><br>SHA-256（base64url）: <code>${escape(hash)}</code></p>
<button id="sign">文書のハッシュに署名する（C2-2）</button>`,
    `
document.getElementById("sign").onclick = async () => {
  const o = await post("/app/api/sign/options", {});
  if (o.status !== 200) return show("C2-2 options を得られない", o);
  const opt = o.body.options;
  try {
    const cred = await navigator.credentials.get({ publicKey: {
      ...opt, challenge: b64.toBuf(opt.challenge), allowCredentials: ids(opt.allowCredentials),
    } });
    const r = cred.response;
    const response = {
      id: cred.id, rawId: b64.fromBuf(cred.rawId), type: cred.type,
      authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
      clientExtensionResults: cred.getClientExtensionResults(),
      response: {
        clientDataJSON: b64.fromBuf(r.clientDataJSON),
        authenticatorData: b64.fromBuf(r.authenticatorData),
        signature: b64.fromBuf(r.signature),
        userHandle: r.userHandle ? b64.fromBuf(r.userHandle) : undefined,
      },
    };
    show("C2-2 サーバーの検証", await post("/app/api/sign/verify", { flow: o.body.flow, response }));
  } catch (e) {
    show("C2-2 ブラウザーが拒んだ", { name: e.name, message: e.message });
  }
};
`,
  );
}
