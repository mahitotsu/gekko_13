package jp.gekko13.backend;

import java.util.List;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * 契約内容を、営業 AI エージェントを経ずに、顧客の登録済みの連絡先へ直接送る（gekko_11 の P-8、P-14）。
 * 登録済みの連絡先は、顧客のアプリの直送の受け口（SVID の mTLS）にある。
 * 送った記録は、届いたかどうかと一緒に残す。届かなかった通知は、送り出しの表から、間を延ばして送り直す（段 D の D1-a3。
 * 送り先のタスクが止まった直後に、1 度で届かなかった。2026-11-24 の AWS）。受信箱は 2 度届いても照合の結果が変わらない。
 */
@Component
class Notifier {

	/** 送る回数の上限（最初の 1 回を含む）。 */
	static final int MAX_ATTEMPTS = 10;

	/** 送り直しで借りた行を、ほかのタスクが取らない間。送る時間（最長でも 15 秒 × 6 回の送り直し）より長くする。 */
	static final long LEASE_MS = 120_000;

	private static final Logger log = LoggerFactory.getLogger(Notifier.class);

	private final Store store;

	private final Courier courier;

	/** 書いた通知を、すぐ 1 度送る処理を動かす先。既定は仮想スレッド。試験では、その場で動かす。 */
	private final java.util.concurrent.Executor kick;

	Notifier(Store store, Courier courier, java.util.concurrent.Executor noticeExecutor) {
		this.store = store;
		this.courier = courier;
		this.kick = noticeExecutor;
	}

	/**
	 * 通知を送り出しの表に「すぐ送る」行として書き、裏ですぐ 1 度送る（段 D の D1-a3）。要求は、送り先の遅れを待たずに返せる。
	 * 届かなければ、Redeliverer が間を延ばして送り直す。宛先がなければ、届かなかった記録だけを残す。
	 */
	void enqueue(List<String> to, Map<String, Object> notice) {
		if (to.isEmpty()) {
			log.info("notice_not_sent: 連絡先の登録がない");
			this.store.addDelivery("(連絡先の登録がない)", notice, false, 1, null, "連絡先の登録がない");
			return;
		}
		long now = System.currentTimeMillis();
		for (String each : to) {
			this.store.addDelivery(each, notice, false, 0, now, null);
		}
		this.kick.execute(this::redeliverDue);
	}

	/** 登録した全ての宛先へ送る。宛先がなければ送らず、届かなかった記録だけを残す（送り直さない）。 */
	void send(List<String> to, Map<String, Object> notice) {
		if (to.isEmpty()) {
			log.info("notice_not_sent: 連絡先の登録がない");
			this.store.addDelivery("(連絡先の登録がない)", notice, false, 1, null, "連絡先の登録がない");
		}
		for (String each : to) {
			Attempt a = attempt(each, notice);
			this.store.addDelivery(each, notice, a.delivered(), 1, a.nextAt(1), a.error());
		}
	}

	/** 送り直しの時期が来た通知を借りて、送り直す。送り直した数を返す。 */
	int redeliverDue() {
		List<Store.Pending> due = this.store.claimDue(System.currentTimeMillis(), 20, LEASE_MS);
		for (Store.Pending p : due) {
			int attempts = p.attempts() + 1;
			Attempt a = attempt(p.to(), p.notice());
			this.store.markAttempt(p.id(), a.delivered(), attempts, a.nextAt(attempts), a.error());
			if (a.delivered()) {
				log.info("notice_redelivered: to={} attempts={}", p.to(), attempts);
			}
			else if (a.nextAt(attempts) == null) {
				log.info("notice_gave_up: to={} attempts={} error={}", p.to(), attempts, a.error());
			}
		}
		return due.size();
	}

	private Attempt attempt(String to, Map<String, Object> notice) {
		// 宛先は、顧客のアプリの直送の受け口だけ
		if (!to.startsWith("/")) {
			log.info("notice_refused: 顧客のアプリの受け口でない宛先 to={}", to);
			return new Attempt(false, false, "顧客のアプリの受け口でない宛先");
		}
		try {
			if (this.courier.deliver(to, notice)) {
				return new Attempt(true, false, null);
			}
			log.info("notice_failed: to={} error=2xx でない応答", to);
			return new Attempt(false, true, "2xx でない応答");
		}
		catch (RuntimeException ex) {
			String error = ex.getClass().getSimpleName() + ": " + ex.getMessage();
			log.info("notice_failed: to={} error={}", to, error);
			return new Attempt(false, true, error);
		}
	}

	/** 次に送り直す時刻（UNIX ミリ秒）。送り直さないときは null。間は 5 秒から倍に延ばし、60 秒で止める。 */
	static long backoffMs(int attempts) {
		return Math.min(5_000L << Math.min(attempts - 1, 10), 60_000L);
	}

	private record Attempt(boolean delivered, boolean retryable, String error) {

		Long nextAt(int attempts) {
			return (this.delivered || !this.retryable || attempts >= MAX_ATTEMPTS) ? null
					: System.currentTimeMillis() + backoffMs(attempts);
		}

	}

}
