package jp.gekko13.auth;

/**
 * 防御が有効か。gekko_13 では、常に有効を返す（SecureDefenses）。gekko_11 の vulnerable の版（gekko_11 の D-24）は写していない。
 */
public interface Defenses {

	/** 認可サーバーで外せる防御（scenarios の 2-3）。 */
	String AUD_ONE = "G3a";

	String SHORT_TTL = "G3b";

	String KEEP_ACT = "G3d";

	String NARROW_TERMS = "G3e";

	String FIXED_TARGET = "G3f";

	/** 交換に出された A の署名、発行者、種類、有効期間を確かめる。 */
	String VERIFY_SUBJECT = "G28";

	boolean enabled(String id);

}
