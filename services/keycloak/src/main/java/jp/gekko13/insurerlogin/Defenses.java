package jp.gekko13.insurerlogin;

import java.util.function.Predicate;

/**
 * 防御が有効か。gekko_13 では、常に有効のままである。gekko_11 の vulnerable の版の差し替え（gekko_11 の D-24）は写していない。
 */
public final class Defenses {

	/** ログインサーバーで外せる防御（scenarios の 2-3）。 */
	public static final String AUD_ONE = "G3a";

	public static final String SHORT_TTL = "G3b";

	public static final String ID_TOKEN_AUD = "G3c";

	private static volatile Predicate<String> enabled = (id) -> true;

	private Defenses() {
	}

	public static boolean enabled(String id) {
		return enabled.test(id);
	}

	public static void use(Predicate<String> predicate) {
		enabled = predicate;
	}

}
