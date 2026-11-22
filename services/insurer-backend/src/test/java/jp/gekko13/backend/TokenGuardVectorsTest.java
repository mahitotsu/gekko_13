package jp.gekko13.backend;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * 共通の例（packages/token-guard/vectors/service-token.json）で、Java の確かめが TypeScript と Python と同じ判定をするかを見る。
 * イメージのビルドでは、例を vectors/ に写してから試験を回す（Dockerfile）。手元では、リポジトリの元の場所から読む。
 */
class TokenGuardVectorsTest {

	private static final ObjectMapper JSON = new ObjectMapper();

	@SuppressWarnings("unchecked")
	static Map<String, Object> vectors() throws Exception {
		Path path = Files.exists(Path.of("vectors/service-token.json")) ? Path.of("vectors/service-token.json")
				: Path.of("../../packages/token-guard/vectors/service-token.json");
		return JSON.readValue(Files.readString(path), Map.class);
	}

	@SuppressWarnings("unchecked")
	static Stream<Map<String, Object>> cases() throws Exception {
		return ((List<Map<String, Object>>) vectors().get("cases")).stream();
	}

	@SuppressWarnings("unchecked")
	@ParameterizedTest(name = "{0}")
	@MethodSource("cases")
	void sameVerdictAsTheOtherLanguages(Map<String, Object> c) throws Exception {
		Map<String, Object> v = vectors();
		JWKSet keys = JWKSet.parse((Map<String, Object>) v.get("jwks"));
		TokenGuard guard = new TokenGuard((String) v.get("service"), (String) v.get("issuer"),
				(List<String>) v.get("allowedCallers"), (kid) -> (RSAKey) keys.getKeyByKeyId(kid),
				() -> Instant.ofEpochSecond(((Number) v.get("now")).longValue()));
		Map<String, Object> peer = (Map<String, Object>) c.get("peer");
		String got;
		try {
			guard.check((String) c.get("authorization"), (String) peer.get("spiffeId"), (String) peer.get("x5tS256"));
			got = "ok";
		}
		catch (TokenGuard.Refusal ex) {
			got = ex.reason;
		}
		assertThat(got).as((String) c.get("name")).isEqualTo(c.get("expect"));
	}

}
