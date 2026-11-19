package jp.gekko13.auth;

import static org.assertj.core.api.Assertions.assertThat;

import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.util.Base64;

import org.junit.jupiter.api.Test;

class SpiffeCertificateVerifierTest {

	private static final String BFF = "spiffe://gekko13.internal/svc/bff";

	@Test
	void SPIFFE_ID_が登録と同じなら一致とする() throws Exception {
		assertThat(SpiffeCertificateVerifier.matches(TestCertificates.withUris(BFF), BFF)).isTrue();
	}

	@Test
	void 別のサービスの_SVID_は一致としない() throws Exception {
		X509Certificate transfer = TestCertificates.withUris("spiffe://gekko13.internal/svc/transfer");
		assertThat(SpiffeCertificateVerifier.matches(transfer, BFF)).isFalse();
	}

	@Test
	void URI_が_2_つあるか_なければ一致としない() throws Exception {
		assertThat(SpiffeCertificateVerifier.matches(TestCertificates.withUris(BFF, "spiffe://x/y"), BFF)).isFalse();
		assertThat(SpiffeCertificateVerifier.matches(TestCertificates.withUris(), BFF)).isFalse();
		assertThat(SpiffeCertificateVerifier.matches(TestCertificates.withUris(BFF), null)).isFalse();
	}

	@Test
	void 拇印は_DER_の_SHA_256_を詰め物なしの_base64url_で書く() throws Exception {
		X509Certificate cert = TestCertificates.withUris(BFF);
		byte[] digest = MessageDigest.getInstance("SHA-256").digest(cert.getEncoded());
		assertThat(SpiffeCertificateVerifier.thumbprint(cert))
			.isEqualTo(Base64.getUrlEncoder().withoutPadding().encodeToString(digest))
			.doesNotContain("=");
	}

}
