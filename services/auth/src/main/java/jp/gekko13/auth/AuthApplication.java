package jp.gekko13.auth;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

/** 段 C の C-4 の認可サーバー。SPIFFE の mTLS を自分で終え、出すトークンを呼び手の SVID の証明書に結ぶ。 */
@SpringBootApplication
@ConfigurationPropertiesScan
public class AuthApplication {

	public static void main(String[] args) {
		SpringApplication.run(AuthApplication.class, args);
	}

}
