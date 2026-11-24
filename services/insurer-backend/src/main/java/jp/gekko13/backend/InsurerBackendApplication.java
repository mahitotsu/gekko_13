package jp.gekko13.backend;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.scheduling.annotation.EnableScheduling;

/** 保険会社のシステム（insurer-backend）。案に署名し、申込みを確かめて契約を記録し、顧客へ直接送る（architecture の 2 章）。 */
@SpringBootApplication
@ConfigurationPropertiesScan
@EnableScheduling
public class InsurerBackendApplication {

	public static void main(String[] args) {
		SpringApplication.run(InsurerBackendApplication.class, args);
	}

}
