package jp.gekko13.auth;

import java.net.MalformedURLException;
import java.net.URI;
import java.net.URL;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.interfaces.RSAPrivateCrtKey;
import java.security.interfaces.RSAPrivateKey;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.RSAPublicKeySpec;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.source.ImmutableJWKSet;
import com.nimbusds.jose.jwk.source.JWKSource;
import com.nimbusds.jose.proc.SecurityContext;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpStatus;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.oauth2.core.AuthorizationGrantType;
import org.springframework.security.oauth2.core.ClientAuthenticationMethod;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.oauth2.server.authorization.JdbcOAuth2AuthorizationService;
import org.springframework.security.oauth2.server.authorization.OAuth2AuthorizationService;
import org.springframework.security.oauth2.server.authorization.OAuth2TokenType;
import org.springframework.security.oauth2.server.authorization.authentication.OAuth2TokenExchangeAuthenticationProvider;
import org.springframework.security.oauth2.server.authorization.authentication.OAuth2TokenExchangeAuthenticationToken;
import org.springframework.security.oauth2.server.authorization.authentication.X509ClientCertificateAuthenticationProvider;
import org.springframework.security.oauth2.server.authorization.client.InMemoryRegisteredClientRepository;
import org.springframework.security.oauth2.server.authorization.client.RegisteredClient;
import org.springframework.security.oauth2.server.authorization.client.RegisteredClientRepository;
import org.springframework.security.oauth2.server.authorization.config.annotation.web.configurers.OAuth2AuthorizationServerConfigurer;
import org.springframework.security.oauth2.server.authorization.settings.AuthorizationServerSettings;
import org.springframework.security.oauth2.server.authorization.settings.ClientSettings;
import org.springframework.security.oauth2.server.authorization.settings.TokenSettings;
import org.springframework.security.oauth2.server.authorization.token.JwtEncodingContext;
import org.springframework.security.oauth2.server.authorization.token.OAuth2TokenCustomizer;
import org.springframework.security.oauth2.server.authorization.web.authentication.X509ClientCertificateAuthenticationConverter;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.HttpStatusEntryPoint;

/**
 * 認可サーバーの組み立て。窓口は 2 つだけ置く。
 * <ul>
 * <li>bff-client: SVID の証明書で認証し（tls_client_auth）、出すトークンをその証明書に結ぶ。client_credentials と交換</li>
 * <li>transfer-client: bff-client と同じ作りで、SPIFFE ID だけが違う。bff のトークンを盗んだ者として、C-4 の判定に使う</li>
 * <li>user-standin: 利用者の代わり（Keycloak を載せるまでの仮）。client_secret で認証し、bff に替えを許すトークン（may_act）を得る</li>
 * </ul>
 */
@Configuration
public class AuthConfig {

	private static final Logger log = LoggerFactory.getLogger(AuthConfig.class);

	static final String BFF = "bff-client";

	static final String TRANSFER = "transfer-client";

	static final String STANDIN = "user-standin";

	private static final Duration ACCESS_TOKEN_TTL = Duration.ofMinutes(5);

	@Bean
	@Order(1)
	SecurityFilterChain authorizationServerChain(HttpSecurity http, OAuth2AuthorizationService authorizationService)
			throws Exception {
		OAuth2AuthorizationServerConfigurer server = OAuth2AuthorizationServerConfigurer.authorizationServer();
		http.securityMatcher(server.getEndpointsMatcher())
			.with(server, (s) -> s
				.clientAuthentication((c) -> c
					.authenticationConverters((converters) -> {
						converters.removeIf((v) -> v instanceof X509ClientCertificateAuthenticationConverter);
						converters.add(0, new SpiffeCertificateConverter());
					})
					.authenticationProviders((providers) -> providers.forEach((p) -> {
						if (p instanceof X509ClientCertificateAuthenticationProvider x509) {
							x509.setCertificateVerifier(new SpiffeCertificateVerifier());
						}
					})))
				.tokenEndpoint((t) -> t.authenticationProviders((providers) -> providers
					.replaceAll((p) -> (p instanceof OAuth2TokenExchangeAuthenticationProvider)
							? new ExchangeGuard(new StandinSubjectPrincipal(p, authorizationService), authorizationService)
							: p))))
			.authorizeHttpRequests((a) -> a.anyRequest().authenticated())
			.exceptionHandling((e) -> e.authenticationEntryPoint(new HttpStatusEntryPoint(HttpStatus.UNAUTHORIZED)));
		return http.build();
	}

	/** 窓口のほかは、何も受けない。 */
	@Bean
	@Order(2)
	SecurityFilterChain denyRest(HttpSecurity http) throws Exception {
		http.authorizeHttpRequests((a) -> a.anyRequest().denyAll())
			.exceptionHandling((e) -> e.authenticationEntryPoint(new HttpStatusEntryPoint(HttpStatus.NOT_FOUND)));
		return http.build();
	}

	@Bean
	RegisteredClientRepository registeredClients(AuthProperties props) {
		RegisteredClient standin = RegisteredClient.withId(STANDIN)
			.clientId(STANDIN)
			.clientSecret("{noop}" + props.standinSecret())
			.clientAuthenticationMethod(ClientAuthenticationMethod.CLIENT_SECRET_BASIC)
			.authorizationGrantType(AuthorizationGrantType.CLIENT_CREDENTIALS)
			.tokenSettings(TokenSettings.builder().accessTokenTimeToLive(ACCESS_TOKEN_TTL).build())
			.build();
		return new InMemoryRegisteredClientRepository(service(BFF, props.spiffeId("bff")),
				service(TRANSFER, props.spiffeId("transfer")), standin);
	}

	/** SVID の証明書で認証し、出すトークンをその証明書に結ぶ窓口。 */
	private static RegisteredClient service(String clientId, String spiffeId) {
		return RegisteredClient.withId(clientId)
			.clientId(clientId)
			.clientAuthenticationMethod(ClientAuthenticationMethod.TLS_CLIENT_AUTH)
			.authorizationGrantType(AuthorizationGrantType.CLIENT_CREDENTIALS)
			.authorizationGrantType(AuthorizationGrantType.TOKEN_EXCHANGE)
			.clientSettings(ClientSettings.builder().setting(SpiffeCertificateVerifier.SPIFFE_ID, spiffeId).build())
			.tokenSettings(TokenSettings.builder()
				.x509CertificateBoundAccessTokens(true)
				.accessTokenTimeToLive(ACCESS_TOKEN_TTL)
				.build())
			.build();
	}

	/**
	 * 認可の記録（交換の元のトークン、交換の記録）は、データベースに置く。複数のタスクのどれに替えを頼んでも、同じ記録を引く（段 D の D1-a1）。
	 * サービスの登録は、設定から毎回同じものを作るので、メモリに置いたままにする。
	 */
	@Bean
	OAuth2AuthorizationService authorizationService(JdbcTemplate jdbc, RegisteredClientRepository clients) {
		return new JdbcOAuth2AuthorizationService(jdbc, clients);
	}

	/**
	 * トークンの形を整える。cnf と act は、標準の部品が先に書く。
	 * 認可の記録はデータベースに JSON で置き、読み戻すときに Jackson の許可の一覧で型を確かめる。List.of や Map.of の型は一覧にないので、
	 * ArrayList と LinkedHashMap で入れる（List.of のままでは、記録を読み戻せずに交換が失敗した。docs/findings.md）。
	 * 利用者の代わりのトークンは、宛先を bff にし、may_act で bff に替えを許す。交換では、求めた宛先を aud にする。
	 */
	@Bean
	OAuth2TokenCustomizer<JwtEncodingContext> tokenShape() {
		return (context) -> {
			if (!OAuth2TokenType.ACCESS_TOKEN.equals(context.getTokenType())) {
				return;
			}
			context.getJwsHeader().type("at+jwt");
			String client = context.getRegisteredClient().getClientId();
			if (STANDIN.equals(client)
					&& AuthorizationGrantType.CLIENT_CREDENTIALS.equals(context.getAuthorizationGrantType())) {
				context.getClaims().audience(new ArrayList<>(List.of(BFF)));
				Map<String, Object> mayAct = new LinkedHashMap<>();
				mayAct.put("iss", issuer(context));
				mayAct.put("sub", BFF);
				context.getClaims().claim("may_act", mayAct);
			}
			if (context.getAuthorizationGrant() instanceof OAuth2TokenExchangeAuthenticationToken exchange) {
				Set<String> audiences = exchange.getAudiences();
				if (audiences.size() == 1) {
					context.getClaims().audience(new ArrayList<>(audiences));
				}
			}
		};
	}

	/**
	 * 標準の交換の部品は、may_act の iss を、保存した actor_token の iss と Objects.equals で比べる。
	 * 保存した iss は URL の型になるので、may_act の iss も URL の型で入れる（gekko_11 の実測 F-G51）。
	 */
	private static URL issuer(JwtEncodingContext context) {
		try {
			return URI.create(context.getAuthorizationServerContext().getIssuer()).toURL();
		}
		catch (MalformedURLException ex) {
			throw new IllegalStateException(ex);
		}
	}

	/**
	 * トークンの発行の鍵。AUTH_SIGNING_KEY（RSA の秘密鍵、PKCS#8 の PEM）があれば、それを使う。複数のタスクが同じ鍵で出し、確かめる
	 * （段 D の D1-a1。aws/deploy.sh が作って SSM に置き、ECS が渡す）。鍵の ID は公開鍵のサムプリント（RFC 7638）にし、どのタスクでも同じにする。
	 * なければ（手元の確かめ）、起動ごとにメモリ上に作る。
	 */
	@Bean
	JWKSource<SecurityContext> jwkSource(@Value("${AUTH_SIGNING_KEY:}") String pem) throws Exception {
		RSAKey key;
		if (pem.isBlank()) {
			KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
			generator.initialize(2048);
			KeyPair pair = generator.generateKeyPair();
			key = new RSAKey.Builder((RSAPublicKey) pair.getPublic()).privateKey((RSAPrivateKey) pair.getPrivate())
				.keyID(UUID.randomUUID().toString())
				.build();
		}
		else {
			key = sharedKey(pem);
		}
		// 複数のタスクが同じ鍵を持つかを、ログで比べられるようにする。鍵の ID は公開鍵のサムプリントで、秘密は出さない
		log.info("signing key: shared={}, kid={}", !pem.isBlank(), key.getKeyID());
		return new ImmutableJWKSet<>(new JWKSet(key));
	}

	/** PKCS#8 の PEM から、秘密鍵と、そこから導いた公開鍵の組を作る。 */
	static RSAKey sharedKey(String pem) throws Exception {
		String body = pem.replaceAll("-----(BEGIN|END) PRIVATE KEY-----", "").replaceAll("\\s", "");
		KeyFactory factory = KeyFactory.getInstance("RSA");
		RSAPrivateCrtKey priv = (RSAPrivateCrtKey) factory
			.generatePrivate(new PKCS8EncodedKeySpec(Base64.getDecoder().decode(body)));
		RSAPublicKey pub = (RSAPublicKey) factory
			.generatePublic(new RSAPublicKeySpec(priv.getModulus(), priv.getPublicExponent()));
		RSAKey key = new RSAKey.Builder(pub).privateKey(priv).build();
		return new RSAKey.Builder(key).keyID(key.computeThumbprint().toString()).build();
	}

	@Bean
	AuthorizationServerSettings authorizationServerSettings(AuthProperties props) {
		return AuthorizationServerSettings.builder().issuer(props.issuer()).build();
	}

}
