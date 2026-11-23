package jp.gekko13.backend;

import java.util.List;
import java.util.Map;

import org.springframework.core.ParameterizedTypeReference;
import org.springframework.stereotype.Component;
import org.springframework.boot.ssl.SslBundles;
import org.springframework.web.client.RestClient;

/** 顧客が登録した passkey の公開鍵を、認可サーバーから引く（4-5）。認可サーバーは、相手の SPIFFE ID で呼び出しを限る。 */
interface PasskeyDirectory {

	/** 登録した passkey の一覧。各要素は id（base64url）と coseKey（base64url の CBOR）。 */
	List<Map<String, String>> keysOf(String user);

	@Component
	class FromAuthServer implements PasskeyDirectory {

		private final BackendProperties props;

		private final SslBundles bundles;

		FromAuthServer(BackendProperties props, SslBundles bundles) {
			this.props = props;
			this.bundles = bundles;
		}

		@Override
		public List<Map<String, String>> keysOf(String user) {
			RestClient auth = SpiffeTls.client(this.bundles, this.props.spiffeId("auth"), SpiffeTls.INTERNAL_TIMEOUT);
			return auth.get().uri(this.props.authUrl() + "/internal/passkeys/{user}", user).retrieve().body(new ParameterizedTypeReference<>() {
			});
		}

	}

}
