package jp.gekko13.auth;

import java.security.Principal;

import org.springframework.security.authentication.AuthenticationProvider;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.core.authority.AuthorityUtils;
import org.springframework.security.oauth2.server.authorization.OAuth2Authorization;
import org.springframework.security.oauth2.server.authorization.OAuth2AuthorizationService;
import org.springframework.security.oauth2.server.authorization.OAuth2TokenType;
import org.springframework.security.oauth2.server.authorization.authentication.OAuth2TokenExchangeAuthenticationToken;

/**
 * 利用者の代わりの窓口（user-standin）が client_credentials で得たトークンを、交換の元にできるようにする。C-4 の間だけの仮の部品。
 * 標準の交換の部品は、元のトークンの保存に利用者（Principal の属性）がないと、invalid_grant で拒む（SAS 1.5.8 で確かめた）。
 * client_credentials の保存には、その属性が入らない。段 D では、ログインサーバー（Keycloak）のトークンを取り込むときに入れる。
 */
final class StandinSubjectPrincipal implements AuthenticationProvider {

	private final AuthenticationProvider delegate;

	private final OAuth2AuthorizationService authorizationService;

	StandinSubjectPrincipal(AuthenticationProvider delegate, OAuth2AuthorizationService authorizationService) {
		this.delegate = delegate;
		this.authorizationService = authorizationService;
	}

	@Override
	public Authentication authenticate(Authentication authentication) throws AuthenticationException {
		String subject = ((OAuth2TokenExchangeAuthenticationToken) authentication).getSubjectToken();
		OAuth2Authorization found = this.authorizationService.findByToken(subject, OAuth2TokenType.ACCESS_TOKEN);
		if (found != null && AuthConfig.STANDIN.equals(found.getRegisteredClientId())
				&& found.getAttribute(Principal.class.getName()) == null) {
			Authentication principal = UsernamePasswordAuthenticationToken.authenticated(found.getPrincipalName(), null,
					AuthorityUtils.NO_AUTHORITIES);
			this.authorizationService
				.save(OAuth2Authorization.from(found).attribute(Principal.class.getName(), principal).build());
		}
		return this.delegate.authenticate(authentication);
	}

	@Override
	public boolean supports(Class<?> authentication) {
		return this.delegate.supports(authentication);
	}

}
