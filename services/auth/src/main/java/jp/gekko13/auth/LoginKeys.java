package jp.gekko13.auth;

import com.nimbusds.jose.KeySourceException;
import com.nimbusds.jose.jwk.JWKMatcher;
import com.nimbusds.jose.jwk.JWKSelector;
import com.nimbusds.jose.jwk.source.JWKSource;
import com.nimbusds.jose.proc.SecurityContext;

/** ログインサーバーの公開鍵。認可サーバーの発行の鍵（JWKSource の Bean）と取り違えないよう、包む。 */
record LoginKeys(JWKSource<SecurityContext> source) {

	/** 鍵を 1 度取る（起動の直後に呼ぶ）。取れなければ例外。 */
	void load() throws KeySourceException {
		if (this.source.get(new JWKSelector(new JWKMatcher.Builder().build()), null).isEmpty()) {
			throw new KeySourceException("ログインサーバーの公開鍵が空");
		}
	}

}
