import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BootstrapAdminInput } from "../shared/types.js";

export async function writeBootstrapAdminFile(dataDir: string, input: BootstrapAdminInput): Promise<string> {
  await mkdir(dataDir, { recursive: true });
  const filePath = path.join(dataDir, "bootstrap-admin.json");
  const payload = {
    username: input.username,
    password: input.password,
  };
  await writeFile(filePath, JSON.stringify(payload, null, 2), { encoding: "utf8", flag: "wx" });
  return filePath;
}
