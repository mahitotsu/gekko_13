package jp.gekko13.backend;

import java.security.KeyFactory;
import java.security.Signature;
import java.security.interfaces.ECPrivateKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.time.Instant;
import java.util.Base64;
import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.ECDSASigner;
import com.nimbusds.jose.crypto.ECDSAVerifier;
import com.nimbusds.jose.jwk.Curve;
import com.nimbusds.jose.jwk.ECKey;
import com.nimbusds.jose.jwk.gen.ECKeyGenerator;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import org.slf4j.LoggerFactory;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * 顧客に示す案の一式に、保険会社の提示の鍵で署名する（gekko_11 の P-1、E7）。提示の鍵は、トークンの発行の鍵と分ける（4-5）。
 * typ を offer+jwt にして、トークン（at+jwt）と取り違えられないようにする。
 */
@Component
class OfferSigner {

	static final String TYP = "offer+jwt";

	static final String ISSUER = "insurer-backend";

	private final ECKey key;

	/**
	 * 提示の鍵。OFFER_SIGNING_KEY（P-256 の秘密鍵と公開鍵の PEM。sharedKey）があれば、それを使う。複数のタスクが同じ鍵で署名し、確かめる
	 * （段 D の D1-a3。aws/deploy.sh が作って SSM に置き、ECS が渡す。判断 37、53）。鍵の ID は公開鍵のサムプリント（RFC 7638）にする。
	 * なければ（試験）、起動ごとにメモリ上に作る。
	 */
	OfferSigner(@Value("${OFFER_SIGNING_KEY:}") String pem) throws Exception {
		this.key = pem.isBlank() ? new ECKeyGenerator(Curve.P_256).keyIDFromThumbprint(true).generate() : sharedKey(pem);
		// 複数のタスクが同じ鍵を持つかを、ログで比べられるようにする。秘密は出さない
		LoggerFactory.getLogger(OfferSigner.class).info("offer key: shared={}, kid={}", !pem.isBlank(), this.key.getKeyID());
	}

	/**
	 * PEM から、P-256 の鍵の組を作る。秘密鍵（PKCS#8 の PRIVATE KEY）と公開鍵（X.509 の PUBLIC KEY）を、続けて並べたもの。
	 * JDK だけでは、EC の秘密鍵から公開鍵を導けないので、aws/deploy.sh が 2 つを並べて置く。2 つが組でなければ止める。
	 */
	static ECKey sharedKey(String pem) throws Exception {
		KeyFactory factory = KeyFactory.getInstance("EC");
		ECPrivateKey priv = (ECPrivateKey) factory.generatePrivate(new PKCS8EncodedKeySpec(block(pem, "PRIVATE KEY")));
		ECPublicKey pub = (ECPublicKey) factory.generatePublic(new X509EncodedKeySpec(block(pem, "PUBLIC KEY")));
		if (!Curve.P_256.equals(Curve.forECParameterSpec(pub.getParams()))) {
			throw new IllegalArgumentException("提示の鍵が P-256 でない");
		}
		ECKey key = new ECKey.Builder(Curve.P_256, pub).privateKey(priv).build();
		Signature signer = Signature.getInstance("SHA256withECDSA");
		signer.initSign(priv);
		signer.update(new byte[] { 1 });
		byte[] signature = signer.sign();
		Signature verifier = Signature.getInstance("SHA256withECDSA");
		verifier.initVerify(pub);
		verifier.update(new byte[] { 1 });
		if (!verifier.verify(signature)) {
			throw new IllegalArgumentException("提示の鍵の秘密鍵と公開鍵が組でない");
		}
		return new ECKey.Builder(key).keyID(key.computeThumbprint().toString()).build();
	}

	private static byte[] block(String pem, String label) {
		Matcher m = Pattern.compile("-----BEGIN " + label + "-----([^-]+)-----END " + label + "-----").matcher(pem);
		if (!m.find()) {
			throw new IllegalArgumentException("提示の鍵に " + label + " がない");
		}
		return Base64.getDecoder().decode(m.group(1).replaceAll("\\s", ""));
	}

	/** 提示集合の識別子（仮称）。案の全体の正規化のハッシュ。 */
	static String offerSetId(String customer, Object plans) {
		return Canonical.challengeOf(Map.of("customer", customer, "plans", plans));
	}

	String sign(String customer, List<Map<String, Object>> plans, String nonce, long expiresAt) throws Exception {
		JWTClaimsSet claims = new JWTClaimsSet.Builder().issuer(ISSUER)
			.issueTime(new Date())
			.expirationTime(Date.from(Instant.ofEpochSecond(expiresAt)))
			.claim("customer", customer)
			.claim("plans", plans)
			.claim("offerSetId", offerSetId(customer, plans))
			.claim("nonce", nonce)
			.build();
		SignedJWT jwt = new SignedJWT(
				new JWSHeader.Builder(JWSAlgorithm.ES256).type(new JOSEObjectType(TYP)).keyID(this.key.getKeyID()).build(),
				claims);
		jwt.sign(new ECDSASigner(this.key));
		return jwt.serialize();
	}

	/** alg、typ、iss、期限を固定して確かめ、案の一式から識別子を作り直して照らす。 */
	Map<String, Object> verify(String jws) throws Exception {
		SignedJWT jwt = SignedJWT.parse(jws);
		if (!JWSAlgorithm.ES256.equals(jwt.getHeader().getAlgorithm())
				|| !new JOSEObjectType(TYP).equals(jwt.getHeader().getType())) {
			throw new IllegalArgumentException("提示の形式が違う");
		}
		if (!jwt.verify(new ECDSAVerifier(this.key.toECPublicKey()))) {
			throw new IllegalArgumentException("提示の署名が違う");
		}
		JWTClaimsSet claims = jwt.getJWTClaimsSet();
		if (!ISSUER.equals(claims.getIssuer()) || claims.getExpirationTime().before(new Date())) {
			throw new IllegalArgumentException("提示の発行元か期限が違う");
		}
		Map<String, Object> payload = claims.toJSONObject();
		if (!offerSetId((String) payload.get("customer"), payload.get("plans")).equals(payload.get("offerSetId"))) {
			throw new IllegalArgumentException("提示集合の識別子が、案の内容と一致しない");
		}
		return payload;
	}

	Map<String, Object> jwks() {
		return Map.of("keys", List.of(this.key.toPublicJWK().toJSONObject()));
	}

}
