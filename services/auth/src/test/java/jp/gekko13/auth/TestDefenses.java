package jp.gekko13.auth;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;

/** テストで、防御を外す。外した ID だけが無効になる（gekko_11 の vulnerable の版と同じ判定）。 */
@TestConfiguration
class TestDefenses {

	static final Set<String> OFF = ConcurrentHashMap.newKeySet();

	@Bean
	@Primary
	Defenses testDefenses() {
		return (id) -> !OFF.contains(id);
	}

}
