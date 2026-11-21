package jp.gekko13.auth;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 認可サーバーの設定。
 *
 * @param issuer トークンの iss
 * @param trustDomain SPIFFE の信頼ドメイン
 * @param loginIssuer ログインサーバーの iss（交換で受け取る A と、連絡先の受け口で受け取る P を出す者）
 * @param loginJwksUrl ログインサーバーの公開鍵。AWS では CloudFront を通した公開の名前で、TLS でログインサーバーを確かめる
 * @param loginUrl ログインサーバーの根の URL（/login まで）。利用者の passkey の公開鍵を、管理の API から読む（gekko_11 の D-42）
 * @param jwtSvidFile ログインサーバーへのクライアント認証に示す JWT-SVID のファイル（gekko_11 の D-38）
 */
@ConfigurationProperties("gekko")
public record AuthProperties(String issuer, String trustDomain, String loginIssuer, String loginJwksUrl,
		String loginUrl, String jwtSvidFile) {

	/** サービスの SPIFFE ID。gekko_13 の登録の形（scripts/spire-registrar.sh）。 */
	public String spiffeId(String service) {
		return "spiffe://" + this.trustDomain + "/svc/" + service;
	}

}
