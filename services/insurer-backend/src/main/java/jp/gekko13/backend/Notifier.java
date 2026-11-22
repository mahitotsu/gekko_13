package jp.gekko13.backend;

import java.time.Duration;
import java.util.Map;

import org.springframework.boot.ssl.SslBundles;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/**
 * 契約内容を、営業 AI エージェントを経ずに、顧客の登録済みの連絡先へ直接送る（gekko_11 の P-8、P-14）。
 * 登録済みの連絡先は、顧客のアプリの直送の受け口（SVID の mTLS）にある。
 * 送った記録は、届いたかどうかと一緒に残す。
 */
@Component
class Notifier {

	private final Store store;

	private final BackendProperties props;

	private final SslBundles bundles;

	Notifier(Store store, BackendProperties props, SslBundles bundles) {
		this.store = store;
		this.props = props;
		this.bundles = bundles;
	}

	/** 登録した全ての宛先へ送る。宛先がなければ送らず、届かなかった記録だけを残す。 */
	void send(java.util.List<String> to, Map<String, Object> notice) {
		if (to.isEmpty()) {
			this.store.outbox.add(new Store.Delivery("(連絡先の登録がない)", notice, false));
		}
		to.forEach((each) -> sendOne(each, notice));
	}

	private void sendOne(String to, Map<String, Object> notice) {
		boolean delivered;
		try {
			// 宛先は、顧客のアプリの直送の受け口だけ。SVID の mTLS で、顧客のアプリの SPIFFE ID を確かめて送る（段 D の D1-a2 の予測 3）
			if (!to.startsWith("/")) {
				throw new IllegalArgumentException("顧客のアプリの受け口でない宛先");
			}
			RestClient client = SpiffeTls.client(this.bundles, this.props.spiffeId("customer-app"), Duration.ofMillis(1500));
			delivered = client.post().uri(this.props.customerAppUrl() + to).body(notice).retrieve().toBodilessEntity()
				.getStatusCode().is2xxSuccessful();
		}
		catch (RuntimeException ex) {
			delivered = false;
		}
		this.store.outbox.add(new Store.Delivery(to, notice, delivered));
	}

}
