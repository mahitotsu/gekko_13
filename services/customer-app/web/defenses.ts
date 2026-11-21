// secure の版。画面の防御（gekko_11 の G22、G23）は、常に効く（gekko_11 の D-24）。防御を外せる複製の帯も出さない。
import type { Defenses } from "./defense-state.ts";

export async function loadDefenses(): Promise<Defenses> {
  return { enabled: () => true };
}
