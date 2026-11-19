package jp.gekko13.auth;

import java.math.BigInteger;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.cert.X509Certificate;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Date;

import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.asn1.x509.Extension;
import org.bouncycastle.asn1.x509.GeneralName;
import org.bouncycastle.asn1.x509.GeneralNames;
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter;
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;

/** テスト用の自己署名の証明書。SAN の URI を、渡した数だけ入れる（SVID の形）。 */
final class TestCertificates {

	private static long serial = 1;

	private TestCertificates() {
	}

	static X509Certificate withUris(String... uris) throws Exception {
		KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
		generator.initialize(256);
		KeyPair pair = generator.generateKeyPair();
		Instant now = Instant.now();
		X500Name subject = new X500Name("O=test");
		JcaX509v3CertificateBuilder builder = new JcaX509v3CertificateBuilder(subject, BigInteger.valueOf(serial++),
				Date.from(now.minus(1, ChronoUnit.MINUTES)), Date.from(now.plus(1, ChronoUnit.HOURS)), subject,
				pair.getPublic());
		if (uris.length > 0) {
			GeneralName[] names = new GeneralName[uris.length];
			for (int i = 0; i < uris.length; i++) {
				names[i] = new GeneralName(GeneralName.uniformResourceIdentifier, uris[i]);
			}
			builder.addExtension(Extension.subjectAlternativeName, false, new GeneralNames(names));
		}
		return new JcaX509CertificateConverter()
			.getCertificate(builder.build(new JcaContentSignerBuilder("SHA256withECDSA").build(pair.getPrivate())));
	}

}
