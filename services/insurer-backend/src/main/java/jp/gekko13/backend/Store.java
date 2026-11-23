package jp.gekko13.backend;

import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * 保険会社のシステムの記憶。2 つのタスクが同じものを読むよう、共有のデータベース（AWS では Aurora）に置く（段 D の D1-a3。判断 53）。
 * 表は schema.sql にある。中身の入れ子の値（契約、申込み、意向確認、通知）は JSON の文字列で置く。
 */
@Component
class Store {

	/** 保険会社の顧客（本人確認を済ませて登録した者）。直送の宛先は、顧客が登録した受信箱で、認可サーバーが持つ（gekko_11 の D-26）。 */
	static final java.util.Set<String> CUSTOMERS = java.util.Set.of("alice", "bob", "mallory", "hanako");

	/** 契約の記録。揉めたときの証拠として、署名済みの申込みと、取り次いだ窓口を残す（gekko_11 の D-9）。 */
	record ContractRecord(Map<String, Object> contract, List<String> by, long at, Object application, Object intent,
			String tokenJti) {
	}

	record Delivery(String to, Map<String, Object> notice, boolean delivered) {
	}

	private static final ObjectMapper JSON = new ObjectMapper();

	private static final TypeReference<Map<String, Object>> MAP = new TypeReference<>() {
	};

	private static final TypeReference<List<String>> STRINGS = new TypeReference<>() {
	};

	private final JdbcTemplate db;

	Store(JdbcTemplate db) {
		this.db = db;
	}

	/** 提示に付けた nonce を、未使用として残す。 */
	void issueNonce(String nonce, String customer, long expiresAt) {
		this.db.update("INSERT INTO offer_nonce (nonce, customer, expires_at, used) VALUES (?, ?, ?, false)", nonce,
				customer, expiresAt);
	}

	/**
	 * nonce を使用済みにする。本人宛てで、未使用で、期限内のときだけ、1 つの文で使用済みに替え、替えられたら true を返す（gekko_11 の G16）。
	 * 2 つのタスクが同じ nonce を同時に使っても、行のロックで片方だけが替えられる（判断 53）。
	 */
	boolean consumeNonce(String nonce, String customer, long now) {
		return this.db.update(
				"UPDATE offer_nonce SET used = true WHERE nonce = ? AND customer = ? AND NOT used AND expires_at >= ?",
				nonce, customer, now) == 1;
	}

	/** 確かめずに使用済みにする（gekko_11 の G16 を外した悪い実装）。 */
	void markNonceUsed(String nonce) {
		this.db.update("UPDATE offer_nonce SET used = true WHERE nonce = ?", nonce);
	}

	void addContract(ContractRecord record) {
		this.db.update(
				"INSERT INTO contract_record (contract, act_chain, at_epoch, application, intent, token_jti) VALUES (?, ?, ?, ?, ?, ?)",
				write(record.contract()), write(record.by()), record.at(), write(record.application()),
				write(record.intent()), record.tokenJti());
	}

	/** 契約の記録を、記録した順に返す。 */
	List<ContractRecord> contracts() {
		return this.db.query(
				"SELECT contract, act_chain, at_epoch, application, intent, token_jti FROM contract_record ORDER BY id",
				(rs, i) -> new ContractRecord(read(rs.getString(1), MAP), read(rs.getString(2), STRINGS), rs.getLong(3),
						read(rs.getString(4), Object.class), read(rs.getString(5), Object.class), rs.getString(6)));
	}

	void addDelivery(Delivery delivery) {
		this.db.update("INSERT INTO delivery (recipient, notice, delivered) VALUES (?, ?, ?)", delivery.to(),
				write(delivery.notice()), delivery.delivered());
	}

	/** 送り出しの記録を、送った順に返す。 */
	List<Delivery> outbox() {
		return this.db.query("SELECT recipient, notice, delivered FROM delivery ORDER BY id",
				(rs, i) -> new Delivery(rs.getString(1), read(rs.getString(2), MAP), rs.getBoolean(3)));
	}

	private static String write(Object value) {
		try {
			return JSON.writeValueAsString(value);
		}
		catch (JsonProcessingException ex) {
			throw new IllegalStateException(ex);
		}
	}

	private static <T> T read(String text, TypeReference<T> type) {
		try {
			return JSON.readValue(text, type);
		}
		catch (JsonProcessingException ex) {
			throw new IllegalStateException(ex);
		}
	}

	private static <T> T read(String text, Class<T> type) {
		try {
			return JSON.readValue(text, type);
		}
		catch (JsonProcessingException ex) {
			throw new IllegalStateException(ex);
		}
	}

}
