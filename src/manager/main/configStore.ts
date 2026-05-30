import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ManagerConfig } from "../shared/types.js";
import { defaultPublicConnectHost } from "../../shared/network.js";

const detectedPublicConnectHost = defaultPublicConnectHost();

const schema = z.object({
  host: z.string().min(1).default("0.0.0.0"),
  port: z.number().int().min(1).max(65535).default(18443),
  dataDir: z.string().min(1),
  tokenTtlMinutes: z.number().int().positive().default(1440),
  serverCommand: z.string().min(1).default("node"),
  serverArgs: z.array(z.string()).default(["dist/main.js"]),
  serverRoot: z.string().default(""),
  publicConnectHost: z.string().min(1).default(detectedPublicConnectHost),
  gamePortStart: z.number().int().min(1).max(65535).default(27015),
  gamePortEnd: z.number().int().min(1).max(65535).default(27030),
  steamAccountToken: z.string().default(""),
});

export class FileConfigStore {
  constructor(private readonly filePath: string, private readonly appRoot: string) {}

  async load(): Promise<ManagerConfig> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8"));
      return this.normalizeLoadedConfig(schema.parse({ dataDir: path.join(this.appRoot, "server-data"), ...raw }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return this.defaultConfig();
    }
  }

  async save(config: ManagerConfig): Promise<void> {
    const parsed = schema.parse(config);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    await writeFile(temp, JSON.stringify(parsed, null, 2), "utf8");
    await rename(temp, this.filePath);
  }

  private defaultConfig(): ManagerConfig {
    return schema.parse({
      dataDir: path.join(this.appRoot, "server-data"),
      serverCommand: this.defaultServerCommand(),
      serverArgs: this.defaultServerArgs(),
    });
  }

  private defaultServerCommand(): string {
    const bundledNode = path.join(this.appRoot, "runtime", "node", "node.exe");
    return existsSync(bundledNode) ? bundledNode : "node";
  }

  private defaultServerArgs(): string[] {
    const packagedBundle = path.join(this.appRoot, "dist", "main.cjs");
    return existsSync(packagedBundle) ? ["dist/main.cjs"] : ["dist/main.js"];
  }

  private normalizeLoadedConfig(config: ManagerConfig): ManagerConfig {
    const defaultCommand = this.defaultServerCommand();
    const defaultArgs = this.defaultServerArgs();
    const command = defaultCommand !== "node" && config.serverCommand !== defaultCommand
      ? defaultCommand
      : config.serverCommand !== "node" && !existsSync(config.serverCommand)
        ? defaultCommand
        : config.serverCommand;
    const serverArgs = defaultArgs[0] === "dist/main.cjs" && config.serverArgs.join(" ") === "dist/main.js"
      ? defaultArgs
      : config.serverArgs;
    return { ...config, serverCommand: command, serverArgs };
  }
}
