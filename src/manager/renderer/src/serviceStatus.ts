import type { ServiceState } from "../../shared/types.js";
import type { TranslationKey, Translator } from "../../../language/types.js";

const serviceStateKeys: Record<ServiceState, TranslationKey> = {
  stopped: "manager.service.status.stopped",
  starting: "manager.service.status.starting",
  running: "manager.service.status.running",
  stopping: "manager.service.status.stopping",
  failed: "manager.service.status.failed",
};

export function serviceStatusLabel(state: ServiceState, t: Translator): string {
  return t(serviceStateKeys[state]);
}
