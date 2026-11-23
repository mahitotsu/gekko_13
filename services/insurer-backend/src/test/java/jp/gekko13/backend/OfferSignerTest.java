package jp.gekko13.backend;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.spec.ECGenParameterSpec;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;

/** 提示の鍵を、複数のタスクで共有する（段 D の D1-a3。判断 37、53）。aws/deploy.sh が置く形（秘密鍵と公開鍵の PEM を並べたもの）を読む。 */
class OfferSignerTest {

	@Test
	void twoTasksWithTheSameKeyVerifyEachOthersOffers() throws Exception {
		String pem = pem(pair());
		OfferSigner one = new OfferSigner(pem);
		OfferSigner other = new OfferSigner(pem);
		assertThat(one.jwks()).isEqualTo(other.jwks());
		List<Map<String, Object>> plans = List.of(Products.plan("fixed", 10, 25, 600_000, 20_000));
		String jws = one.sign("alice", plans, "n-1", Instant.now().plusSeconds(60).getEpochSecond());
		assertThat(other.verify(jws)).containsEntry("nonce", "n-1");
	}

	@Test
	void keyIdIsTheThumbprintOfThePublicKey() throws Exception {
		String kid = OfferSigner.sharedKey(pem(pair())).getKeyID();
		assertThat(kid).hasSize(43);
	}

	@Test
	void privateAndPublicKeysThatAreNotAPairAreRefused() throws Exception {
		KeyPair a = pair();
		KeyPair b = pair();
		String mixed = block("PRIVATE KEY", a.getPrivate().getEncoded()) + block("PUBLIC KEY", b.getPublic().getEncoded());
		assertThatThrownBy(() -> OfferSigner.sharedKey(mixed)).hasMessageContaining("組でない");
	}

	private static KeyPair pair() throws Exception {
		KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
		generator.initialize(new ECGenParameterSpec("secp256r1"));
		return generator.generateKeyPair();
	}

	private static String pem(KeyPair pair) {
		return block("PRIVATE KEY", pair.getPrivate().getEncoded()) + block("PUBLIC KEY", pair.getPublic().getEncoded());
	}

	private static String block(String label, byte[] der) {
		return "-----BEGIN " + label + "-----\n" + Base64.getMimeEncoder(64, "\n".getBytes()).encodeToString(der)
				+ "\n-----END " + label + "-----\n";
	}

}
