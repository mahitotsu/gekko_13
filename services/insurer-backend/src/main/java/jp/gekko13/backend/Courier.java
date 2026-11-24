package jp.gekko13.backend;

import java.util.Map;

import org.springframework.boot.ssl.SslBundles;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/** 通知を 1 つの宛先へ送る。試験では差し替える。 */
interface Courier {

	/** 届いたら true。2xx でなければ false。つなげなければ例外。 */
	boolean deliver(String to, Map<String, Object> notice);

	/** 顧客のアプリの直送の受け口へ、SVID の mTLS で、顧客のアプリの SPIFFE ID を確かめて送る（段 D の D1-a2 の予測 3）。 */
	@Component
	class ToCustomerApp implements Courier {

		private final BackendProperties props;

		private final SslBundles bundles;

		ToCustomerApp(BackendProperties props, SslBundles bundles) {
			this.props = props;
			this.bundles = bundles;
		}

		@Override
		public boolean deliver(String to, Map<String, Object> notice) {
			RestClient client = SpiffeTls.client(this.bundles, this.props.spiffeId("customer-app"), SpiffeTls.INTERNAL_TIMEOUT);
			return client.post().uri(this.props.customerAppUrl() + to).body(notice).retrieve().toBodilessEntity()
				.getStatusCode().is2xxSuccessful();
		}

	}

}
