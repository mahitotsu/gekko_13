package jp.gekko13.backend;

import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanContext;
import io.opentelemetry.api.trace.TraceFlags;
import io.opentelemetry.api.trace.TraceState;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import org.springframework.context.annotation.Profile;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** 書いた通知をすぐ送る処理を動かす先（Notifier.enqueue）。 */
@org.springframework.context.annotation.Configuration
class NoticeKick {

	@org.springframework.context.annotation.Bean
	java.util.concurrent.Executor noticeExecutor() {
		return java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor();
	}

}

/** 届かなかった通知を、5 秒ごとに送り直す。2 つのタスクのどちらが送ってもよい（行は Store.claimDue で借りる）。試験では動かさない。 */
@Component
@Profile("!test")
class Redeliverer {

	/** 取らない（sampled でない）トレースの文脈。5 秒ごとの処理がトレースを埋めないように、この下のスパンを作らせない（段 T）。 */
	private static final Context UNSAMPLED = Context.root()
		.with(Span.wrap(SpanContext.createFromRemoteParent("00000000000000000000000000000001", "0000000000000001", TraceFlags.getDefault(),
				TraceState.getDefault())));

	private final Notifier notifier;

	Redeliverer(Notifier notifier) {
		this.notifier = notifier;
	}

	@Scheduled(initialDelay = 5_000, fixedDelay = 5_000)
	void run() {
		try (Scope ignored = UNSAMPLED.makeCurrent()) {
			this.notifier.redeliverDue();
		}
	}

}
