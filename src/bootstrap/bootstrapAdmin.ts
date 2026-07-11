import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { usernameSchema } from "../accounts/accountInputSchemas.js";
import type { AccountService } from "../accounts/accountService.js";
import { pathExists } from "../storage/jsonFile.js";

const schema = z.object({
  username: usernameSchema,
  password: z.string().min(8),
});

export interface BootstrapResult { created: boolean; reason: "created" | "accounts-exist"; }

export async function bootstrapAdmin(accounts: AccountService, bootstrapFile: string): Promise<BootstrapResult> {
  if ((await accounts.listAccounts()).length > 0) return { created: false, reason: "accounts-exist" };
  if (!(await pathExists(bootstrapFile))) {
    await writeFile(`${bootstrapFile}.example`, JSON.stringify({ username: "admin", password: "change-me-now" }, null, 2), "utf8");
    throw new Error(`No accounts exist. Create bootstrap-admin.json at ${bootstrapFile} using ${bootstrapFile}.example, then restart the server.`);
  }
  const input = schema.parse(JSON.parse(await readFile(bootstrapFile, "utf8")));
  await accounts.createAccount({ username: input.username, password: input.password, role: "admin", steam64: "", mustChangePassword: false });
  return { created: true, reason: "created" };
}
