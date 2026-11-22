package jp.gekko13.backend;

import java.text.ParseException;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.function.Supplier;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.crypto.RSASSAVerifier;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jwt.JWT;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.JWTParser;
import com.nimbusds.jwt.SignedJWT;

/**
 * 受け口でサービスのトークン（C）を確かめる（gekko_11 の token-guard の受け口。防御 G5〜G8、G26、G27、G29）。
 * gekko_11 では Envoy と token-guard（TypeScript）が確かめた。gekko_13 は Envoy を置かないので、このアプリが自分で確かめる。
 * 拒む理由の符号と確かめる順は、TypeScript（packages/token-guard）と Python（事務サービス）とそろえ、
 * 共通の例（packages/token-guard/vectors/service-token.json）で、同じ判定になることを試験で確かめる。
 * 確かめる順: 相手の SPIFFE ID → Authorization: Bearer → 署名 → typ → iss → aud → exp → cnf の x5t#S256 と相手の証明書。
 */
final class TokenGuard {

	static final class Refusal extends RuntimeException {

		final int status;

		final String reason;

		Refusal(int status, String reason, String message) {
			super(message);
			this.status = status;
			this.reason = reason;
		}

	}

	private final String service;

	private final String issuer;

	private final List<String> allowedCallers;

	/** 鍵の ID から公開鍵を返す。見つからなければ null。 */
	private final Function<String, RSAKey> keyFor;

	private final Supplier<Instant> now;

	TokenGuard(String service, String issuer, List<String> allowedCallers, Function<String, RSAKey> keyFor,
			Supplier<Instant> now) {
		this.service = service;
		this.issuer = issuer;
		this.allowedCallers = allowedCallers;
		this.keyFor = keyFor;
		this.now = now;
	}

	/** 確かめた主張を返す。 */
	Map<String, Object> check(String authorization, String peerId, String peerX5t) {
		if (peerId == null) {
			throw new Refusal(401, "no_peer", "相手の証明書がない");
		}
		if (!this.allowedCallers.contains(peerId)) {
			throw new Refusal(403, "wrong_caller", "呼んでよい相手ではない: " + peerId);
		}
		String[] parts = (authorization == null) ? new String[0] : authorization.split(" ");
		if (parts.length != 2 || !"Bearer".equals(parts[0]) || parts[1].isEmpty()) {
			throw new Refusal(401, "no_token", "Authorization: Bearer がない");
		}
		JWTClaimsSet claims = verify(parts[1]);
		Object cnf = claims.getClaim("cnf");
		Object bound = (cnf instanceof Map<?, ?> m) ? m.get("x5t#S256") : null;
		if (bound == null || peerX5t == null || !bound.equals(peerX5t)) {
			throw new Refusal(401, "not_bound", "トークンが、相手の証明書に結ばれていない");
		}
		return claims.toJSONObject();
	}

	JWTClaimsSet verify(String token) {
		JWT parsed;
		try {
			parsed = JWTParser.parse(token);
		}
		catch (ParseException ex) {
			throw new Refusal(401, "bad_token", "トークンが読めない: " + ex.getMessage());
		}
		if (!(parsed instanceof SignedJWT jwt) || !JWSAlgorithm.RS256.equals(jwt.getHeader().getAlgorithm())) {
			throw new Refusal(401, "bad_signature", "RS256 の署名がない");
		}
		RSAKey key = this.keyFor.apply(jwt.getHeader().getKeyID());
		try {
			if (key == null || !jwt.verify(new RSASSAVerifier(key))) {
				throw new Refusal(401, "bad_signature", "署名が違う");
			}
		}
		catch (JOSEException ex) {
			throw new Refusal(401, "bad_signature", "署名を確かめられない: " + ex.getMessage());
		}
		if (jwt.getHeader().getType() == null || !"at+jwt".equals(jwt.getHeader().getType().getType())) {
			throw new Refusal(401, "bad_typ", "typ が at+jwt でない");
		}
		JWTClaimsSet claims;
		try {
			claims = jwt.getJWTClaimsSet();
		}
		catch (ParseException ex) {
			throw new Refusal(401, "bad_token", "主張が読めない: " + ex.getMessage());
		}
		if (!this.issuer.equals(claims.getIssuer())) {
			throw new Refusal(401, "bad_issuer", "発行者が違う: " + claims.getIssuer());
		}
		if (claims.getAudience() == null || !claims.getAudience().contains(this.service)) {
			throw new Refusal(401, "bad_audience", "宛先が違う: " + claims.getAudience());
		}
		if (claims.getExpirationTime() == null || !claims.getExpirationTime().toInstant().isAfter(this.now.get())) {
			throw new Refusal(401, "expired", "期限が切れた");
		}
		if (claims.getSubject() == null) {
			throw new Refusal(401, "bad_token", "sub がない");
		}
		return claims;
	}

}
