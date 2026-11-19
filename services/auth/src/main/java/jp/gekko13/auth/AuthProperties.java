package jp.gekko13.auth;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 認可サーバーの設定。
 *
 * @param issuer トークンの iss
 * @param trustDomain SPIFFE の信頼ドメイン
 * @param standinSecret 利用者の代わりの窓口（user-standin）の client_secret。local/up.sh が作って渡す
 */
@ConfigurationProperties("gekko")
public record AuthProperties(String issuer, String trustDomain, String standinSecret) {

	/** サービスの SPIFFE ID（spiffe://信頼ドメイン/svc/名前）。 */
	public String spiffeId(String service) {
		return "spiffe://" + this.trustDomain + "/svc/" + service;
	}

}
