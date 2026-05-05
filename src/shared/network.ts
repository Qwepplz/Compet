import os from "node:os";

function isUsableIpv4(address: string): boolean {
  return address.length > 0 && address !== "127.0.0.1" && !address.startsWith("169.254.");
}

export function defaultPublicConnectHost(fallback = "127.0.0.1"): string {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (isUsableIpv4(entry.address)) return entry.address;
    }
  }

  return fallback;
}
