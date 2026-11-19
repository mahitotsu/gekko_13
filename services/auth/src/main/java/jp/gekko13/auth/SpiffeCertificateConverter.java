package jp.gekko13.auth;

import java.security.cert.X509Certificate;
import java.util.Map;

import jakarta.servlet.http.HttpServletRequest;

import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.core.ClientAuthenticationMethod;
import org.springframework.security.oauth2.core.OAuth2AuthenticationException;
import org.springframework.security.oauth2.core.OAuth2ErrorCodes;
import org.springframework.security.oauth2.core.endpoint.OAuth2ParameterNames;
import org.springframework.security.oauth2.server.authorization.authentication.OAuth2ClientAuthenticationToken;
import org.springframework.security.web.authentication.AuthenticationConverter;
import org.springframework.util.StringUtils;

/**
 * TLS で示された証明書を、tls_client_auth の認証として受け取る。
 * 標準の変換部品は、連鎖が 1 枚だと self_signed_tls_client_auth とみなす。SPIRE の SVID は 1 枚で示されるので、差し替える
 * （gekko_11 の実測 F-G50）。連鎖は、Tomcat の TLS の層が SPIRE のバンドルで確かめ済みである。
 */
final class SpiffeCertificateConverter implements AuthenticationConverter {

	static final String CERTIFICATE_ATTRIBUTE = "jakarta.servlet.request.X509Certificate";

	@Override
	public Authentication convert(HttpServletRequest request) {
		X509Certificate[] chain = (X509Certificate[]) request.getAttribute(CERTIFICATE_ATTRIBUTE);
		if (chain == null || chain.length == 0) {
			return null;
		}
		String[] clientIds = request.getParameterValues(OAuth2ParameterNames.CLIENT_ID);
		if (clientIds == null || clientIds.length == 0 || !StringUtils.hasText(clientIds[0])) {
			return null;
		}
		if (clientIds.length != 1) {
			throw new OAuth2AuthenticationException(OAuth2ErrorCodes.INVALID_REQUEST);
		}
		return new OAuth2ClientAuthenticationToken(clientIds[0], ClientAuthenticationMethod.TLS_CLIENT_AUTH, chain,
				Map.of());
	}

}
