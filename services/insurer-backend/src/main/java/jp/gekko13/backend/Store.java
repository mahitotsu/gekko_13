package jp.gekko13.backend;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

import org.springframework.stereotype.Component;

/** 保険会社のシステムの記憶。まず 1 タスクなので、メモリ上に置く（共有の保存先へ移すのは段 D の D1-a3）。 */
@Component
class Store {

	/** 保険会社の顧客（本人確認を済ませて登録した者）。直送の宛先は、顧客が登録した受信箱で、認可サーバーが持つ（gekko_11 の D-26）。 */
	static final java.util.Set<String> CUSTOMERS = java.util.Set.of("alice", "bob", "mallory", "hanako");

	record Nonce(String customer, long expiresAt, boolean used) {
	}

	/** 契約の記録。揉めたときの証拠として、署名済みの申込みと、取り次いだ窓口を残す（gekko_11 の D-9）。 */
	record ContractRecord(Map<String, Object> contract, List<String> by, long at, Object application, Object intent,
			String tokenJti) {
	}

	record Delivery(String to, Map<String, Object> notice, boolean delivered) {
	}

	final Map<String, Nonce> nonces = new ConcurrentHashMap<>();

	final List<ContractRecord> contracts = new CopyOnWriteArrayList<>();

	final List<Delivery> outbox = new CopyOnWriteArrayList<>();

}
