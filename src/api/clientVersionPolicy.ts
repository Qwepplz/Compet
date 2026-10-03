import { compareSemver, isSemver } from "../shared/version.js";
import { HttpError } from "./httpErrors.js";

export function assertClientVersion(value: unknown, requiredClientVersion: string): void {
  if (!isSemver(requiredClientVersion)) throw new Error("Invalid requiredClientVersion");
  if (typeof value !== "string" || !isSemver(value)) {
    throw new HttpError(426, "client_version_invalid", "Invalid client version", requiredClientVersion);
  }
  if (compareSemver(value, requiredClientVersion) < 0) {
    throw new HttpError(426, "client_update_required", "Client update required", requiredClientVersion);
  }
}
