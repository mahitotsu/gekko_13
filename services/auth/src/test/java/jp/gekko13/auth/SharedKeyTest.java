package jp.gekko13.auth;

import static org.assertj.core.api.Assertions.assertThat;

import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.util.Base64;

import com.nimbusds.jose.jwk.RSAKey;

import org.junit.jupiter.api.Test;

/** 複数のタスクが同じ PEM から、同じ鍵（同じ鍵の ID と公開鍵）を作ること。 */
class SharedKeyTest {

	@Test
	void samePemGivesSameKeyIdAndPublicKey() throws Exception {
		KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
		generator.initialize(2048);
		KeyPair pair = generator.generateKeyPair();
		String pem = "-----BEGIN PRIVATE KEY-----\n"
				+ Base64.getMimeEncoder(64, "\n".getBytes()).encodeToString(pair.getPrivate().getEncoded())
				+ "\n-----END PRIVATE KEY-----\n";

		RSAKey first = AuthorizationServerConfig.sharedKey(pem);
		RSAKey second = AuthorizationServerConfig.sharedKey(pem);

		assertThat(first.getKeyID()).isEqualTo(second.getKeyID()).isEqualTo(first.computeThumbprint().toString());
		assertThat(first.toRSAPublicKey()).isEqualTo(pair.getPublic());
		assertThat(first.isPrivate()).isTrue();
	}

}
