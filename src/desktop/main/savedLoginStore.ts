import { promises as fs } from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";

export interface SavedLoginRecord {
  baseUrl?: string;
  token?: string;
  username?: string;
  password?: string;
}

type PasswordEncoding = "safeStorage" | "plain";

interface SavedLoginFile {
  baseUrl?: string;
  token?: string;
  username?: string;
  password?: string;
  passwordEncoding?: PasswordEncoding;
}

export class SavedLoginStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<SavedLoginRecord | null> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<SavedLoginFile>;
      const record: SavedLoginRecord = {};
      if (typeof parsed.baseUrl === "string") record.baseUrl = parsed.baseUrl;
      if (typeof parsed.token === "string") record.token = parsed.token;
      if (typeof parsed.username === "string") record.username = parsed.username;
      const password = decodePassword(parsed);
      if (password !== undefined) record.password = password;
      return hasAnyValue(record) ? record : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return null;
    }
  }

  async save(record: SavedLoginRecord): Promise<void> {
    const file: SavedLoginFile = {};
    if (record.baseUrl) file.baseUrl = record.baseUrl;
    if (record.token) file.token = record.token;
    if (record.username) file.username = record.username;
    if (record.password) {
      Object.assign(file, encodePassword(record.password));
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(file), "utf8");
  }

  async clearToken(): Promise<void> {
    const current = await this.load();
    if (!current) {
      await this.remove();
      return;
    }

    await this.save({
      baseUrl: current.baseUrl,
      username: current.username,
      password: current.password,
    });
  }

  async clear(): Promise<void> {
    await this.remove();
  }

  private async remove(): Promise<void> {
    try {
      await fs.unlink(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function encodePassword(password: string): Pick<SavedLoginFile, "password" | "passwordEncoding"> {
  if (safeStorage.isEncryptionAvailable()) {
    return {
      password: safeStorage.encryptString(password).toString("base64"),
      passwordEncoding: "safeStorage",
    };
  }

  return { password, passwordEncoding: "plain" };
}

function decodePassword(file: Partial<SavedLoginFile>): string | undefined {
  if (typeof file.password !== "string") {
    return undefined;
  }
  if (file.passwordEncoding === "safeStorage") {
    try {
      return safeStorage.decryptString(Buffer.from(file.password, "base64"));
    } catch {
      return undefined;
    }
  }
  if (file.passwordEncoding === "plain") {
    return file.password;
  }
  return undefined;
}

function hasAnyValue(record: SavedLoginRecord): boolean {
  return Boolean(record.baseUrl || record.token || record.username || record.password);
}
