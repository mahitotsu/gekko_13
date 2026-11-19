package jp.gekko13.auth;

import java.security.cert.X509Certificate;
import java.util.Collection;
import java.util.List;
import java.util.Map;

import org.springframework.security.authentication.AuthenticationProvider;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.oauth2.core.OAuth2AuthenticationException;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.core.OAuth2ErrorCodes;
import org.springframework.security.oauth2.server.authorization.OAuth2Authorization;
import org.springframework.security.oauth2.server.authorization.OAuth2AuthorizationService;
import org.springframework.security.oauth2.server.authorization.OAuth2TokenType;
import org.springframework.security.oauth2.server.authorization.authentication.OAuth2ClientAuthenticationToken;
import org.springframework.security.oauth2.server.authorization.authentication.OAuth2TokenExchangeAuthenticationToken;

/**
 * 交換の前に、標準の部品が確かめないことを確かめてから、標準の部品に渡す（gekko_11 の防御 G3 の一部を、C-4 に要る分だけ）。
 * <ul>
 * <li>替えを頼む者が、tls_client_auth（SVID の証明書）で認証したこと</li>
 * <li>subject_token の宛先と may_act が、替えを頼む者であること</li>
 * <li>actor_token が、替えを頼む者自身のもので、いま示した証明書に結ばれていること（盗んだトークンを、別の SVID で使えない）</li>
 * </ul>
 * act の付与と、出すトークンの cnf は、標準の部品が書く。
 */
final class ExchangeGuard implements AuthenticationProvider {

	private final AuthenticationProvider delegate;

	private final OAuth2AuthorizationService authorizationService;

	ExchangeGuard(AuthenticationProvider delegate, OAuth2AuthorizationService authorizationService) {
		this.delegate = delegate;
		this.authorizationService = authorizationService;
	}

	@Override
	public Authentication authenticate(Authentication authentication) throws AuthenticationException {
		OAuth2TokenExchangeAuthenticationToken exchange = (OAuth2TokenExchangeAuthenticationToken) authentication;
		if (!(exchange.getPrincipal() instanceof OAuth2ClientAuthenticationToken client) || !client.isAuthenticated()
				|| !(client.getCredentials() instanceof X509Certificate[] chain) || chain.length == 0) {
			throw reject(OAuth2ErrorCodes.INVALID_CLIENT, "exchange requires tls_client_auth");
		}
		String requester = client.getRegisteredClient().getClientId();

		Map<String, Object> subject = claimsOf(exchange.getSubjectToken());
		if (subject == null || !audiences(subject).contains(requester) || !requester.equals(mayActSub(subject))) {
			throw reject(OAuth2ErrorCodes.INVALID_GRANT, "subject_token does not allow the requester to act");
		}

		Map<String, Object> actor = claimsOf(exchange.getActorToken());
		if (actor == null || !requester.equals(actor.get("sub"))
				|| !SpiffeCertificateVerifier.thumbprint(chain[0]).equals(x5t(actor))) {
			throw reject(OAuth2ErrorCodes.INVALID_GRANT, "actor_token is not bound to the requester certificate");
		}
		return this.delegate.authenticate(authentication);
	}

	@Override
	public boolean supports(Class<?> authentication) {
		return this.delegate.supports(authentication);
	}

	private Map<String, Object> claimsOf(String token) {
		if (token == null) {
			return null;
		}
		OAuth2Authorization authorization = this.authorizationService.findByToken(token, OAuth2TokenType.ACCESS_TOKEN);
		if (authorization == null) {
			return null;
		}
		OAuth2Authorization.Token<?> found = authorization.getToken(token);
		return (found == null || !found.isActive()) ? null : found.getClaims();
	}

	private static Collection<?> audiences(Map<String, Object> claims) {
		Object aud = claims.get("aud");
		return (aud instanceof Collection<?> c) ? c : (aud == null) ? List.of() : List.of(aud);
	}

	private static Object mayActSub(Map<String, Object> claims) {
		return (claims.get("may_act") instanceof Map<?, ?> mayAct) ? mayAct.get("sub") : null;
	}

	private static Object x5t(Map<String, Object> claims) {
		return (claims.get("cnf") instanceof Map<?, ?> cnf) ? cnf.get("x5t#S256") : null;
	}

	private static OAuth2AuthenticationException reject(String code, String description) {
		return new OAuth2AuthenticationException(new OAuth2Error(code, description, null));
	}

}
