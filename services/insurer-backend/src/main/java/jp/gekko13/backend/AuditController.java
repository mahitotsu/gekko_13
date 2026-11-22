package jp.gekko13.backend;

import java.util.Map;

import jakarta.servlet.http.HttpServletRequest;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 契約の記録と直送の記録を、監査の役と監査サービスにだけ見せる（gekko_11 の D-17、P-7）。トークンは使わず、相手の SPIFFE ID
 * （auditor、insurer-audit）で限る。相手の SPIFFE ID は、TLS の層が確かめた証明書から読む。
 * 監査サービスは、これを保険会社のシステムの自己申告として、CloudWatch Logs に残った第三者の記録と突き合わせる。
 */
@RestController
class AuditController {

	private final Store store;

	private final BackendProperties props;

	AuditController(Store store, BackendProperties props) {
		this.store = store;
		this.props = props;
	}

	@GetMapping("/audit/records")
	ResponseEntity<?> records(HttpServletRequest request) {
		String peer = SpiffeTls.peerOf(request).flatMap(SpiffeTls::spiffeIdOf).orElse(null);
		if (!this.props.spiffeId("auditor").equals(peer) && !this.props.spiffeId("insurer-audit").equals(peer)) {
			return ResponseEntity.status(403).body(Map.of("error", "監査の役ではない"));
		}
		return ResponseEntity.ok(Map.of("contracts", this.store.contracts, "outbox", this.store.outbox));
	}

}
