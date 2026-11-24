package jp.gekko13.backend;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.cert.X509Certificate;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.Collections;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.nimbusds.jose.jwk.JWK;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.boot.ssl.SslBundles;
import org.springframework.context.annotation.Profile;
import org.springframework.context.event.EventListener;
import org.springframework.core.annotation.Order;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * 受け口の確かめ（段 D の D1-a2-2）。gekko_11 では、Envoy と token-guard が確かめ、主張をヘッダー（x-auth-claims）で渡した。
 * gekko_13 では、このフィルターが、相手の証明書（Tomcat が SPIRE のバンドルで確かめたもの）と C を確かめ、取り次いだ窓口の登録が
 * 有効かを認可サーバーに問い合わせ（gekko_11 の G10）、確かめた主張を同じ形のヘッダーで controller に渡す。
 * 外から来た同じ名前のヘッダーは、どの受け口でも捨てる。トークンを使わない受け口（提示の公開鍵、監査の記録）は、ヘッダーを付けずに通す。
 * 試験（test のプロファイル）では使わない。controller の試験は、確かめた後のヘッダーを直接渡す。
 */
@Component
@Profile("!test")
@Order(1)
class TokenGuardFilter extends OncePerRequestFilter {

	static final String CLAIMS = "x-auth-claims";

	private static final Logger log = LoggerFactory.getLogger(TokenGuardFilter.class);

	private static final List<String> OPEN = List.of("/offers-jwks.json", "/audit/");

	private static final Duration TIMEOUT = SpiffeTls.INTERNAL_TIMEOUT;

	private final BackendProperties props;

	private final SslBundles bundles;

	private final TokenGuard guard;

	private final Map<String, RSAKey> keys = new ConcurrentHashMap<>();

	private volatile Instant fetched = Instant.EPOCH;

	private final ObjectMapper json = new ObjectMapper();

	TokenGuardFilter(BackendProperties props, SslBundles bundles) {
		this.props = props;
		this.bundles = bundles;
		this.guard = new TokenGuard("insurer-backend", props.issuer(), List.of(props.spiffeId("insurer-mcp")), this::keyFor,
				Instant::now);
	}

	/** 認可サーバーの公開鍵。起動したらすぐ取り（warmKeys）、知らない鍵の ID が来たら、10 秒に 1 回まで取り直す。 */
	private RSAKey keyFor(String kid) {
		RSAKey key = this.keys.get(String.valueOf(kid));
		if (key == null && Instant.now().isAfter(this.fetched.plusSeconds(10))) {
			this.fetched = Instant.now();
			try {
				fetchKeys();
			}
			catch (RuntimeException ex) {
				// 取り直せなければ、手元の鍵で確かめ続ける
				log.info("keys_refresh_failed: {}", ex.getMessage());
			}
			key = this.keys.get(String.valueOf(kid));
		}
		return key;
	}

	private void fetchKeys() {
		String body = SpiffeTls.client(this.bundles, this.props.spiffeId("auth"), TIMEOUT)
			.get()
			.uri(this.props.authUrl() + "/oauth2/jwks")
			.retrieve()
			.body(String.class);
		try {
			for (JWK jwk : JWKSet.parse(body).getKeys()) {
				if (jwk instanceof RSAKey rsa) {
					this.keys.put(String.valueOf(rsa.getKeyID()), rsa);
				}
			}
		}
		catch (java.text.ParseException ex) {
			throw new IllegalStateException("認可サーバーの公開鍵が読めない", ex);
		}
	}

	/**
	 * 起動したらすぐ、認可サーバーの公開鍵を取る。取れるまで、間を延ばして取り直す。受け始めるのは待たない（段 D の D1-a3）。
	 * 鍵を持たないまま要求を受けると、その要求の中で取りに行き、送り先が止まった直後には待たされる（2026-11-24 の AWS）。
	 */
	@EventListener(ApplicationReadyEvent.class)
	void warmKeys() {
		Thread.ofVirtual().name("keys-warm").start(() -> {
			for (long delay = 1_000;; delay = Math.min(delay * 2, 10_000)) {
				try {
					fetchKeys();
					this.fetched = Instant.now();
					log.info("keys_ready");
					return;
				}
				catch (RuntimeException ex) {
					log.info("keys_retry: {} in {}ms", ex.getMessage(), delay);
					try {
						Thread.sleep(delay);
					}
					catch (InterruptedException ie) {
						Thread.currentThread().interrupt();
						return;
					}
				}
			}
		});
	}

	/** 取り次いだ窓口とトークンを受け取ったクライアントの登録が、外れていないか（gekko_11 の G10）。 */
	private boolean active(String token) {
		LinkedMultiValueMap<String, String> form = new LinkedMultiValueMap<>();
		form.add("token", token);
		form.add("client_id", "insurer-backend");
		Map<?, ?> body = SpiffeTls.client(this.bundles, this.props.spiffeId("auth"), TIMEOUT)
			.post()
			.uri(this.props.authUrl() + "/oauth2/introspect")
			.contentType(MediaType.APPLICATION_FORM_URLENCODED)
			.body(form)
			.retrieve()
			.body(Map.class);
		return body != null && Boolean.TRUE.equals(body.get("active"));
	}

	@Override
	protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
			throws ServletException, IOException {
		String path = request.getRequestURI();
		if (OPEN.stream().anyMatch(path::startsWith)) {
			chain.doFilter(new WithClaims(request, null), response);
			return;
		}
		Optional<X509Certificate> peer = SpiffeTls.peerOf(request);
		String peerId = peer.flatMap(SpiffeTls::spiffeIdOf).orElse(null);
		try {
			Map<String, Object> claims = this.guard.check(request.getHeader("authorization"), peerId,
					peer.map(SpiffeTls::x5tS256).orElse(null));
			String token = request.getHeader("authorization").substring("Bearer ".length());
			if (!active(token)) {
				throw new TokenGuard.Refusal(403, "inactive", "トークンが無効か、取り次いだ窓口の登録が外れている");
			}
			Map<String, Object> summary = new LinkedHashMap<>();
			summary.put("claims", claims);
			summary.put("peer", Map.of("spiffeId", peerId));
			String header = Base64.getUrlEncoder()
				.withoutPadding()
				.encodeToString(this.json.writeValueAsString(summary).getBytes(StandardCharsets.UTF_8));
			chain.doFilter(new WithClaims(request, header), response);
		}
		catch (TokenGuard.Refusal ex) {
			log.info("refused: reason={} peer={} error={}", ex.reason, peerId, ex.getMessage());
			response.setStatus(ex.status);
			response.setContentType("application/json");
			response.setCharacterEncoding("UTF-8");
			response.getWriter().write(this.json.writeValueAsString(Map.of("error", ex.getMessage(), "reason", ex.reason)));
		}
	}

	/** 外から来た x-auth-claims を捨て、確かめた主張（あれば）に替える。 */
	private static final class WithClaims extends HttpServletRequestWrapper {

		private final String claims;

		WithClaims(HttpServletRequest request, String claims) {
			super(request);
			this.claims = claims;
		}

		@Override
		public String getHeader(String name) {
			return CLAIMS.equalsIgnoreCase(name) ? this.claims : super.getHeader(name);
		}

		@Override
		public Enumeration<String> getHeaders(String name) {
			if (CLAIMS.equalsIgnoreCase(name)) {
				return (this.claims == null) ? Collections.emptyEnumeration() : Collections.enumeration(List.of(this.claims));
			}
			return super.getHeaders(name);
		}

		@Override
		public Enumeration<String> getHeaderNames() {
			List<String> names = Collections.list(super.getHeaderNames());
			names.removeIf(CLAIMS::equalsIgnoreCase);
			if (this.claims != null) {
				names.add(CLAIMS);
			}
			return Collections.enumeration(names);
		}

	}

}
