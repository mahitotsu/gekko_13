package jp.gekko13.backend;

import java.util.List;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 保険会社のシステムの設定（段 D の D1-a2-2）。
 *
 * @param trustDomain SPIFFE の信頼ドメイン
 * @param issuer 受け取るトークン C の発行者（認可サーバー）
 * @param authUrl 認可サーバー。SVID の mTLS で、相手の SPIFFE ID を確かめて呼ぶ
 * @param customerAppUrl 顧客のアプリの直送の受け口。SVID の mTLS で、相手の SPIFFE ID を確かめて呼ぶ
 * @param rpId passkey の RP ID
 * @param origins 署名した画面の origin（顧客のアプリ）
 */
@ConfigurationProperties("gekko")
public record BackendProperties(String trustDomain, String issuer, String authUrl, String customerAppUrl, String rpId,
		List<String> origins) {

	/** サービスの SPIFFE ID。gekko_13 の登録の形（scripts/spire-registrar.sh）。 */
	public String spiffeId(String service) {
		return "spiffe://" + this.trustDomain + "/svc/" + service;
	}

}
