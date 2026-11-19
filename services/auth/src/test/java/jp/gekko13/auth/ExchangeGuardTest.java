package jp.gekko13.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.security.cert.X509Certificate;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import org.springframework.security.authentication.AuthenticationProvider;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.core.AuthorizationGrantType;
import org.springframework.security.oauth2.core.ClientAuthenticationMethod;
import org.springframework.security.oauth2.core.OAuth2AccessToken;
import org.springframework.security.oauth2.core.OAuth2AuthenticationException;
import org.springframework.security.oauth2.server.authorization.InMemoryOAuth2AuthorizationService;
import org.springframework.security.oauth2.server.authorization.OAuth2Authorization;
import org.springframework.security.oauth2.server.authorization.authentication.OAuth2ClientAuthenticationToken;
import org.springframework.security.oauth2.server.authorization.authentication.OAuth2TokenExchangeAuthenticationToken;
import org.springframework.security.oauth2.server.authorization.client.RegisteredClient;

class ExchangeGuardTest {

	private static final String ACCESS = "urn:ietf:params:oauth:token-type:access_token";

	private final InMemoryOAuth2AuthorizationService store = new InMemoryOAuth2AuthorizationService();

	private final Authentication passed = new TestingAuthenticationToken("passed", null);

	private final AuthenticationProvider delegate = new AuthenticationProvider() {
		@Override
		public Authentication authenticate(Authentication a) {
			return ExchangeGuardTest.this.passed;
		}

		@Override
		public boolean supports(Class<?> c) {
			return true;
		}
	};

	private final ExchangeGuard guard = new ExchangeGuard(this.delegate, this.store);

	private final RegisteredClient bff = RegisteredClient.withId(AuthConfig.BFF)
		.clientId(AuthConfig.BFF)
		.clientAuthenticationMethod(ClientAuthenticationMethod.TLS_CLIENT_AUTH)
		.authorizationGrantType(AuthorizationGrantType.TOKEN_EXCHANGE)
		.build();

	private X509Certificate bffCert;

	private X509Certificate otherCert;

	@BeforeEach
	void setUp() throws Exception {
		this.bffCert = TestCertificates.withUris("spiffe://gekko13.internal/svc/bff");
		this.otherCert = TestCertificates.withUris("spiffe://gekko13.internal/svc/bff");
		save("subject", Map.of("sub", AuthConfig.STANDIN, "aud", List.of(AuthConfig.BFF), "may_act",
				Map.of("sub", AuthConfig.BFF)));
		save("actor", Map.of("sub", AuthConfig.BFF, "cnf",
				Map.of("x5t#S256", SpiffeCertificateVerifier.thumbprint(this.bffCert))));
	}

	@Test
	void 結ばれた証明書で頼めば標準の部品に渡す() {
		assertThat(this.guard.authenticate(exchange(this.bffCert, "subject", "actor"))).isSameAs(this.passed);
	}

	@Test
	void 同じ_SPIFFE_ID_でも別の証明書なら拒む() {
		assertThatThrownBy(() -> this.guard.authenticate(exchange(this.otherCert, "subject", "actor")))
			.isInstanceOf(OAuth2AuthenticationException.class)
			.hasMessageContaining("actor_token is not bound");
	}

	@Test
	void may_act_が頼む者でなければ拒む() {
		save("subject2", Map.of("sub", AuthConfig.STANDIN, "aud", List.of(AuthConfig.BFF), "may_act",
				Map.of("sub", "transfer-client")));
		assertThatThrownBy(() -> this.guard.authenticate(exchange(this.bffCert, "subject2", "actor")))
			.isInstanceOf(OAuth2AuthenticationException.class)
			.hasMessageContaining("subject_token");
	}

	@Test
	void 証明書なしの認証では拒む() {
		OAuth2ClientAuthenticationToken client = new OAuth2ClientAuthenticationToken(this.bff,
				ClientAuthenticationMethod.CLIENT_SECRET_BASIC, "secret");
		OAuth2TokenExchangeAuthenticationToken request = new OAuth2TokenExchangeAuthenticationToken(ACCESS, "subject",
				ACCESS, client, "actor", ACCESS, Set.of(), Set.of(), Set.of(), Map.of());
		assertThatThrownBy(() -> this.guard.authenticate(request)).isInstanceOf(OAuth2AuthenticationException.class)
			.hasMessageContaining("tls_client_auth");
	}

	private OAuth2TokenExchangeAuthenticationToken exchange(X509Certificate cert, String subject, String actor) {
		OAuth2ClientAuthenticationToken client = new OAuth2ClientAuthenticationToken(this.bff,
				ClientAuthenticationMethod.TLS_CLIENT_AUTH, new X509Certificate[] { cert });
		return new OAuth2TokenExchangeAuthenticationToken(ACCESS, subject, ACCESS, client, actor, ACCESS, Set.of(),
				Set.of(), Set.of(), Map.of());
	}

	private void save(String value, Map<String, Object> claims) {
		Instant now = Instant.now();
		OAuth2AccessToken token = new OAuth2AccessToken(OAuth2AccessToken.TokenType.BEARER, value, now,
				now.plusSeconds(300));
		this.store.save(OAuth2Authorization.withRegisteredClient(this.bff)
			.id(value)
			.principalName(String.valueOf(claims.get("sub")))
			.authorizationGrantType(AuthorizationGrantType.CLIENT_CREDENTIALS)
			.token(token, (m) -> m.put(OAuth2Authorization.Token.CLAIMS_METADATA_NAME, claims))
			.build());
	}

}
