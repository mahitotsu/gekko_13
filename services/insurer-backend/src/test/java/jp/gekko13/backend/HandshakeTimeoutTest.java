package jp.gekko13.backend;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpConnectTimeoutException;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

import org.junit.jupiter.api.Test;

/**
 * SpiffeTls が頼る JDK の挙動（段 D の D1-a3）。HttpClient の connectTimeout は、TLS の握手まで含む。TCP はつながるが握手で黙る相手
 * （止まったタスクへ向かった Service Connect の中継と同じ見え方）でも、握手の待ちで HttpConnectTimeoutException になり、送り直しの対象になる。
 */
class HandshakeTimeoutTest {

	@Test
	void connectTimeoutCoversTheTlsHandshake() throws Exception {
		List<Socket> held = new ArrayList<>();
		try (ServerSocket silent = new ServerSocket(0, 50, InetAddress.getLoopbackAddress())) {
			Thread.ofVirtual().start(() -> {
				try {
					while (true) {
						held.add(silent.accept());
					}
				}
				catch (Exception ex) {
					// 閉じたら終わる
				}
			});
			HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofMillis(300)).build();
			HttpRequest request = HttpRequest.newBuilder(URI.create("https://127.0.0.1:" + silent.getLocalPort() + "/x"))
				.timeout(Duration.ofSeconds(5))
				.build();
			long started = System.nanoTime();
			assertThatThrownBy(() -> client.send(request, HttpResponse.BodyHandlers.ofString()))
				.isInstanceOf(HttpConnectTimeoutException.class);
			assertThat((System.nanoTime() - started) / 1_000_000).isLessThan(2_000);
		}
		finally {
			for (Socket s : held) {
				s.close();
			}
		}
	}

}
