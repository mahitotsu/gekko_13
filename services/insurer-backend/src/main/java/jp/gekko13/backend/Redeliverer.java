package jp.gekko13.backend;

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

	private final Notifier notifier;

	Redeliverer(Notifier notifier) {
		this.notifier = notifier;
	}

	@Scheduled(initialDelay = 5_000, fixedDelay = 5_000)
	void run() {
		this.notifier.redeliverDue();
	}

}
