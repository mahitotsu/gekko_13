import { defineConfig } from "vitest/config";

// 段 D の D1-b のシナリオ（test/scenarios）。手元の環境（local/up.sh と local/up.sh probes）が要るので、npm test には入れない。
// 役どうしで状態（登録の外しなど）を共有するので、順に回す
export default defineConfig({ test: { include: ["test/scenarios/**/*.test.ts"], testTimeout: 180_000, fileParallelism: false, sequence: { concurrent: false } } });
