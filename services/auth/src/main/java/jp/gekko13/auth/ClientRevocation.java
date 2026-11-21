package jp.gekko13.auth;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * 登録を外したクライアント。新しいトークンを出さず、出したトークンも有効性の問い合わせで無効にする（gekko_11 の G4、G10）。
 * 外したことは、共有のデータベースに置く。どのタスクで外しても、全部のタスクで効く（段 D の D1-a2）。
 */
@Component
class ClientRevocation {

	private final JdbcTemplate jdbc;

	ClientRevocation(JdbcTemplate jdbc) {
		this.jdbc = jdbc;
	}

	boolean isRevoked(String clientId) {
		Integer n = this.jdbc.queryForObject("SELECT count(*) FROM client_revocation WHERE client_id = ?", Integer.class,
				clientId);
		return n != null && n > 0;
	}

	void revoke(String clientId) {
		this.jdbc.update("INSERT INTO client_revocation (client_id) VALUES (?) ON CONFLICT DO NOTHING", clientId);
	}

	void restore(String clientId) {
		this.jdbc.update("DELETE FROM client_revocation WHERE client_id = ?", clientId);
	}

}
