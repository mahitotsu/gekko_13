package jp.gekko13.auth;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.cert.CertificateEncodingException;
import java.security.cert.CertificateParsingException;
import java.security.cert.X509Certificate;
import java.util.Base64;
import java.util.Collection;
import java.util.List;
import java.util.function.Consumer;

import org.springframework.security.oauth2.core.OAuth2AuthenticationException;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.core.OAuth2ErrorCodes;
import org.springframework.security.oauth2.server.authorization.authentication.OAuth2ClientAuthenticationContext;

/**
 * tls_client_auth で、証明書の SAN の URI（SPIFFE ID）を、登録した SPIFFE ID と照らす。
 * 標準の照合は Subject DN を見るが、SVID の Subject は空のことがあるので差し替える。
 */
final class SpiffeCertificateVerifier implements Consumer<OAuth2ClientAuthenticationContext> {

	static final String SPIFFE_ID = "spiffe_id";

	private static final int URI_NAME = 6;

	@Override
	public void accept(OAuth2ClientAuthenticationContext context) {
		X509Certificate[] chain = (X509Certificate[]) context.getAuthentication().getCredentials();
		String expected = context.getRegisteredClient().getClientSettings().getSetting(SPIFFE_ID);
		if (!matches(chain[0], expected)) {
			throw new OAuth2AuthenticationException(
					new OAuth2Error(OAuth2ErrorCodes.INVALID_CLIENT, "Client authentication failed: spiffe_id", null));
		}
	}

	/** SPIFFE の X.509-SVID は URI の SAN をちょうど 1 つ持つ。2 つ以上や 0 は、一致としない。 */
	static boolean matches(X509Certificate certificate, String expected) {
		List<String> uris = uriNames(certificate);
		return expected != null && uris.size() == 1 && expected.equals(uris.get(0));
	}

	static List<String> uriNames(X509Certificate certificate) {
		try {
			Collection<List<?>> names = certificate.getSubjectAlternativeNames();
			if (names == null) {
				return List.of();
			}
			return names.stream().filter((n) -> (Integer) n.get(0) == URI_NAME).map((n) -> (String) n.get(1)).toList();
		}
		catch (CertificateParsingException ex) {
			return List.of();
		}
	}

	/** RFC 8705 の x5t#S256。証明書の DER の SHA-256 を、詰め物なしの base64url で書く。 */
	static String thumbprint(X509Certificate certificate) {
		try {
			byte[] digest = MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded());
			return Base64.getUrlEncoder().withoutPadding().encodeToString(digest);
		}
		catch (NoSuchAlgorithmException | CertificateEncodingException ex) {
			throw new IllegalStateException(ex);
		}
	}

}
