package jp.gekko13.auth;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 認可の記録に入れる値を、Jackson の許可の一覧にある型（ArrayList、LinkedHashMap）に写す。
 * 認可の記録はデータベースに JSON で置き（段 D の D1-a1）、読み戻すときに Spring Security が許可の一覧で型を確かめる。
 * List.of、Map.of、JWT の部品が作る Map の型は一覧になく、読み戻せずに交換が失敗する。Long も一覧にない（JSON の数で読み戻せる
 * Integer にする）。試験（H2 に書いて読み戻す）で確かめた。
 */
final class Plain {

	private Plain() {
	}

	@SuppressWarnings("unchecked")
	static <T> T copy(T value) {
		if (value instanceof Map<?, ?> map) {
			Map<String, Object> out = new LinkedHashMap<>();
			map.forEach((k, v) -> out.put(String.valueOf(k), copy(v)));
			return (T) out;
		}
		if (value instanceof Collection<?> list) {
			List<Object> out = new ArrayList<>();
			list.forEach((v) -> out.add(copy(v)));
			return (T) out;
		}
		// int に収まる Long は Integer にする。収まらない Long は写さず、読み戻しで失敗させる（黙って値を変えない）
		if (value instanceof Long n && n >= Integer.MIN_VALUE && n <= Integer.MAX_VALUE) {
			return (T) Integer.valueOf(n.intValue());
		}
		return value;
	}

}
