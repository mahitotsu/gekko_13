package jp.gekko13.auth;

import java.security.Principal;
import java.util.List;
import java.util.Map;

import jakarta.servlet.http.HttpServletRequest;

import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * 顧客の受信箱の番号（直送の宛先）を、本人が登録した連絡先として受け取る（gekko_11 の P-14、D-26）。登録は、ログインサーバーが出した P を示した顧客だけが行う（gekko_11 の D-42）。
 * 保険会社のシステムには、連絡先を渡す。参照は、保険会社のシステムの SPIFFE ID だけが行える。
 */
@RestController
class ContactController {

	/** 顧客ごとの受信箱の番号（直送の宛先）。端末ごとに登録し、全てに送る。共有のデータベースに置き、どのタスクでも同じものを返す。 */
	private final JdbcTemplate jdbc;

	/** 受信箱の番号は、推測できない長さの base64url（128 ビット以上）に限る。 */
	private static final java.util.regex.Pattern INBOX = java.util.regex.Pattern.compile("[A-Za-z0-9_-]{22,64}");

	private final AuthProperties props;

	ContactController(AuthProperties props, JdbcTemplate jdbc) {
		this.props = props;
		this.jdbc = jdbc;
	}

	private List<String> inboxesOf(String customer) {
		return this.jdbc.queryForList("SELECT inbox FROM contact_inbox WHERE customer = ? ORDER BY created", String.class,
				customer);
	}

	/** 本文は {inbox: 受信箱の番号}。顧客のアプリの BFF が、ログインの後に、端末の番号を登録する。 */
	@PostMapping("/contacts/inbox")
	ResponseEntity<?> registerInbox(Principal user, @RequestBody Map<String, Object> body) {
		if (!(body.get("inbox") instanceof String inbox) || !INBOX.matcher(inbox).matches()) {
			return ResponseEntity.badRequest().body(Map.of("error", "受信箱の番号がない"));
		}
		this.jdbc.update("INSERT INTO contact_inbox (customer, inbox) VALUES (?, ?) ON CONFLICT DO NOTHING", user.getName(),
				inbox);
		return ResponseEntity.ok(Map.of("ok", true));
	}

	/** ログインした本人が登録した受信箱の番号の一覧。 */
	@GetMapping("/contacts/mine")
	Map<String, Object> mine(Principal user) {
		return Map.of("inboxes", inboxesOf(user.getName()));
	}

	@GetMapping("/internal/contacts/{user}")
	ResponseEntity<?> contact(@PathVariable String user, HttpServletRequest request) {
		if (!PeerIdentity.is(request, this.props.spiffeId("insurer-backend"))) {
			return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("error", "保険会社のシステムではない"));
		}
		return ResponseEntity.ok(Map.of("inboxes", inboxesOf(user)));
	}

}
