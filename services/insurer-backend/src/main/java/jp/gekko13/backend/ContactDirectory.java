package jp.gekko13.backend;

import java.util.List;
import java.util.Map;

import org.springframework.core.ParameterizedTypeReference;
import org.springframework.stereotype.Component;
import org.springframework.boot.ssl.SslBundles;
import org.springframework.web.client.RestClient;

/**
 * 顧客が登録した連絡先（受信箱の番号）を、認可サーバーから引く（gekko_11 の P-14、D-26）。直送の宛先は、申込みに書かれた連絡先ではなく、これにする（gekko_11 の G18）。
 * 認可サーバーは、相手の SPIFFE ID で呼び出しを限る。
 */
interface ContactDirectory {

	/** 受信箱の番号（端末ごと）。登録がなければ空。 */
	List<String> inboxesOf(String user);

	@Component
	class FromAuthServer implements ContactDirectory {

		private final BackendProperties props;

		private final SslBundles bundles;

		FromAuthServer(BackendProperties props, SslBundles bundles) {
			this.props = props;
			this.bundles = bundles;
		}

		@Override
		public List<String> inboxesOf(String user) {
			// 認可サーバーを、SVID の mTLS で、相手の SPIFFE ID を確かめて呼ぶ（段 D の D1-a2 の予測 3）
			RestClient auth = SpiffeTls.client(this.bundles, this.props.spiffeId("auth"), SpiffeTls.INTERNAL_TIMEOUT);
			Map<String, List<String>> body = auth.get().uri(this.props.authUrl() + "/internal/contacts/{user}", user).retrieve().body(
					new ParameterizedTypeReference<>() {
					});
			return (body == null) ? List.of() : body.getOrDefault("inboxes", List.of());
		}

	}

}
