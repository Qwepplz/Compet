export type StartupGateState = "checking_update" | "checking_admission" | "update_required" | "connection_failed" | "installing" | "ready";
export interface StartupGateContext {
  state: StartupGateState;
  generation: number;
  currentVersion?: string;
  availableVersion?: string;
  requiredClientVersion?: string;
  code?: string;
}
export function reduceStartupGate(state: StartupGateContext, event: StartupGateContext): StartupGateContext {
  if (event.generation < state.generation) return state;
  if (event.generation === state.generation && (state.state === "update_required" || state.state === "connection_failed") && event.state === "ready") return state;
  return { ...state, ...event };
}
