package jp.gekko13.backend;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;

import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;

/** テストの差し替え。防御は外した ID だけ無効にし、passkey の公開鍵は手元の認証器から返す。 */
@TestConfiguration
class TestBackendConfig {

	static final Map<String, String> OFF = new ConcurrentHashMap<>();

	static final Map<String, List<Map<String, String>>> PASSKEYS = new ConcurrentHashMap<>();

	@Bean
	@Primary
	Defenses testDefenses() {
		return new Defenses() {
			@Override
			public boolean enabled(String id) {
				return !OFF.containsKey(id);
			}

			@Override
			public Optional<String> variant(String id) {
				return Optional.ofNullable(OFF.get(id));
			}
		};
	}

	@Bean
	@Primary
	PasskeyDirectory testPasskeys() {
		return (user) -> PASSKEYS.getOrDefault(user, List.of());
	}

	/** 直送で、これから失敗させる回数。 */
	static final AtomicInteger FAIL_NEXT = new AtomicInteger();

	/** 届いた直送の宛先。 */
	static final List<String> DELIVERED = new CopyOnWriteArrayList<>();

	/** 顧客のアプリの直送の受け口の代わり。FAIL_NEXT の回数だけ、つなげない（例外）。 */
	@Bean
	@Primary
	Courier testCourier() {
		return (to, notice) -> {
			if (FAIL_NEXT.getAndUpdate((n) -> Math.max(n - 1, 0)) > 0) {
				throw new IllegalStateException("つなげない（試験）");
			}
			DELIVERED.add(to);
			return true;
		};
	}

	/** 書いた通知をすぐ送る処理は、試験では、その場で動かす（試験どうしで、裏の送りが混ざらない）。 */
	@Bean
	@Primary
	java.util.concurrent.Executor testNoticeKick() {
		return Runnable::run;
	}

	/** 顧客ごとの受信箱の番号（認可サーバーに登録した連絡先の代わり）。 */
	@Bean
	@Primary
	ContactDirectory testContacts() {
		return (user) -> List.of("inbox-of-" + user + "-0123456789ab");
	}

}
