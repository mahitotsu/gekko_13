package jp.gekko13.backend;

import java.net.Socket;
import java.net.http.HttpClient;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.CertificateParsingException;
import java.security.cert.X509Certificate;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509ExtendedTrustManager;
import javax.net.ssl.X509TrustManager;

import jakarta.servlet.http.HttpServletRequest;

import org.springframework.boot.ssl.SslBundle;
import org.springframework.boot.ssl.SslBundles;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.web.client.RestClient;

/**
 * SVID（SSL バンドル svid。spiffe-helper が書くファイル）で mTLS を受け、また呼ぶ（段 D の D1-a2-2）。
 * <ul>
 * <li>受け口: Tomcat が相手の証明書を SPIRE のバンドルで確かめる。相手の SPIFFE ID と x5t#S256 は、要求の属性から読む</li>
 * <li>呼ぶ側: SVID には DNS の SAN がないので、名前ではなく、相手の SPIFFE ID を確かめる。確かめは TLS の握手の中で行うので、
 * 確かめていない相手には、要求（トークン）を送らない。SVID は入れ替わるので、呼ぶたびに今のバンドルで作り、接続を使い回さない</li>
 * </ul>
 */
final class SpiffeTls {

	static final String CERTIFICATES = "jakarta.servlet.request.X509Certificate";

	private SpiffeTls() {
	}

	/** 証明書の SAN の URI のうち SPIFFE ID。ちょうど 1 つのときだけ返す。 */
	static Optional<String> spiffeIdOf(X509Certificate cert) {
		List<String> ids = new ArrayList<>();
		try {
			Collection<List<?>> sans = cert.getSubjectAlternativeNames();
			if (sans != null) {
				for (List<?> san : sans) {
					if (Integer.valueOf(6).equals(san.get(0)) && String.valueOf(san.get(1)).startsWith("spiffe://")) {
						ids.add(String.valueOf(san.get(1)));
					}
				}
			}
		}
		catch (CertificateParsingException ex) {
			return Optional.empty();
		}
		return (ids.size() == 1) ? Optional.of(ids.get(0)) : Optional.empty();
	}

	/** RFC 8705 の x5t#S256（DER の SHA-256 の base64url）。 */
	static String x5tS256(X509Certificate cert) {
		try {
			return Base64.getUrlEncoder()
				.withoutPadding()
				.encodeToString(MessageDigest.getInstance("SHA-256").digest(cert.getEncoded()));
		}
		catch (Exception ex) {
			throw new IllegalStateException(ex);
		}
	}

	/** 要求の相手の証明書（TLS の層が確かめたもの）。 */
	static Optional<X509Certificate> peerOf(HttpServletRequest request) {
		X509Certificate[] chain = (X509Certificate[]) request.getAttribute(CERTIFICATES);
		return (chain == null || chain.length == 0) ? Optional.empty() : Optional.of(chain[0]);
	}

	/**
	 * サービスどうしの呼び出しの待ち（つなぐときと読むとき）。止まったタスクに当たると、Service Connect が別のタスクへつなぎ直す
	 * （つなぎの失敗を 2 回までリトライする。ECS の資料）。その間にアプリが見切らないよう、長めにとる（段 D の D1-a3。推定の値）。
	 */
	static final Duration INTERNAL_TIMEOUT = Duration.ofSeconds(15);

	/** 応答が届く前につなぎが切れたときに、送り直す回数の上限（最初の 1 回を含む）。 */
	static final int ATTEMPTS = 6;

	/**
	 * 相手の SPIFFE ID を確かめて呼ぶ RestClient。呼ぶたびに作る。応答が届く前につなぎが切れたら（IOException）、最大 6 回まで、間を 0.3 秒ずつ延ばして送り直す。
	 * Service Connect の外れ値の検出が、止まったタスクを避けるまで続ける（外れ値の検出は、直近 30 秒に 5 回以上失敗したタスクを避ける。ECS の資料。3 回では避けられる前に送り終えた。2026-11-23 の AWS）
	 * （段 D の D1-a3。止まったタスクへのつなぎを、Service Connect は救いきれなかった。2026-11-23 の AWS）。相手の SPIFFE ID が違うときは、
	 * 送り直さない。送るのは、passkey の公開鍵と連絡先の読み取り（GET）と、顧客のアプリへの直送（2 度届くと、受信箱に同じ通知が 2 つ並ぶが、
	 * 照合は契約の内容で行うので、結果は変わらない）。
	 */
	static RestClient client(SslBundles bundles, String expectedId, Duration timeout) {
		SslBundle bundle = bundles.getBundle("svid");
		try {
			TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
			tmf.init(bundle.getStores().getTrustStore());
			X509TrustManager base = (X509TrustManager) tmf.getTrustManagers()[0];
			SSLContext ctx = SSLContext.getInstance("TLSv1.3");
			ctx.init(bundle.getManagers().getKeyManagers(), new javax.net.ssl.TrustManager[] { new Expecting(base, expectedId) },
					null);
			HttpClient http = HttpClient.newBuilder().sslContext(ctx).connectTimeout(timeout).build();
			JdkClientHttpRequestFactory factory = new JdkClientHttpRequestFactory(http);
			factory.setReadTimeout(timeout);
			return RestClient.builder().requestFactory(factory).requestInterceptor((request, body, execution) -> {
				for (int i = 1;; i++) {
					try {
						return execution.execute(request, body);
					}
					catch (java.io.IOException ex) {
						if (i >= ATTEMPTS || ex instanceof javax.net.ssl.SSLPeerUnverifiedException) {
							throw ex;
						}
						try {
							Thread.sleep(300L * i);
						}
						catch (InterruptedException ie) {
							Thread.currentThread().interrupt();
							throw ex;
						}
					}
				}
			}).build();
		}
		catch (Exception ex) {
			throw new IllegalStateException("mTLS の呼び出しを作れない: " + ex.getMessage(), ex);
		}
	}

	/**
	 * 連鎖を SPIRE のバンドルで確かめ、さらに相手の SPIFFE ID を照らす。X509ExtendedTrustManager の形で、名前の照合は行わない
	 * （名前の照合は、標準の TrustManager が、ソケットや SSLEngine を渡されたときに行う。ここでは渡さない）。
	 */
	private static final class Expecting extends X509ExtendedTrustManager {

		private final X509TrustManager base;

		private final String expectedId;

		Expecting(X509TrustManager base, String expectedId) {
			this.base = base;
			this.expectedId = expectedId;
		}

		@Override
		public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
			this.base.checkServerTrusted(chain, authType);
			String got = spiffeIdOf(chain[0]).orElse("(なし)");
			if (!this.expectedId.equals(got)) {
				throw new CertificateException("相手の SPIFFE ID が違う: " + got);
			}
		}

		@Override
		public void checkServerTrusted(X509Certificate[] chain, String authType, Socket socket) throws CertificateException {
			checkServerTrusted(chain, authType);
		}

		@Override
		public void checkServerTrusted(X509Certificate[] chain, String authType, SSLEngine engine) throws CertificateException {
			checkServerTrusted(chain, authType);
		}

		@Override
		public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
			throw new CertificateException("呼ぶ側の TrustManager である");
		}

		@Override
		public void checkClientTrusted(X509Certificate[] chain, String authType, Socket socket) throws CertificateException {
			checkClientTrusted(chain, authType);
		}

		@Override
		public void checkClientTrusted(X509Certificate[] chain, String authType, SSLEngine engine) throws CertificateException {
			checkClientTrusted(chain, authType);
		}

		@Override
		public X509Certificate[] getAcceptedIssuers() {
			return this.base.getAcceptedIssuers();
		}

	}

}
