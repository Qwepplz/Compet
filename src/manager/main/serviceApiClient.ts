import https from "node:https";
import type { AccountView, CreateAccountInput, LoginResult, UpdateAccountInput } from "../shared/types.js";

function readHttpErrorMessage(data: unknown, fallback: string): string {
  if (typeof data !== "object" || data === null) return fallback;
  const envelope = data as { message?: unknown; error?: { message?: unknown } };
  if (typeof envelope.message === "string") return envelope.message;
  if (typeof envelope.error?.message === "string") return envelope.error.message;
  return fallback;
}

export class ServiceApiClient {
  private token?: string;

  constructor(private readonly baseUrl: string) {}

  async serverInfo(): Promise<{ version: string; certificateFingerprintSha256: string; websocketPath: string }> {
    return this.request("GET", "/server/info");
  }

  async login(username: string, password: string): Promise<LoginResult> {
    this.token = undefined;
    const response = await this.request<{ token: string; account: AccountView }>("POST", "/auth/manager-login", { username, password });
    this.token = response.token;
    return { account: response.account };
  }

  logout(): void {
    this.token = undefined;
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await this.request("POST", "/auth/change-password", { currentPassword, newPassword });
  }

  async accounts(): Promise<AccountView[]> {
    const response = await this.request<{ accounts: AccountView[] }>("GET", "/admin/accounts");
    return response.accounts;
  }

  async createAccount(input: CreateAccountInput): Promise<AccountView> {
    const response = await this.request<{ account: AccountView }>("POST", "/admin/accounts", input);
    return response.account;
  }

  async updateAccount(id: string, input: UpdateAccountInput): Promise<AccountView> {
    const response = await this.request<{ account: AccountView }>("PATCH", `/admin/accounts/${id}`, input);
    return response.account;
  }

  async resetPassword(id: string, password: string): Promise<AccountView> {
    const response = await this.request<{ account: AccountView }>("POST", `/admin/accounts/${id}/reset-password`, { password });
    return response.account;
  }

  async deleteAccount(id: string): Promise<void> {
    await this.request<{ ok: boolean }>("DELETE", `/admin/accounts/${encodeURIComponent(id)}`);
  }

  private request<T>(method: string, route: string, body?: unknown): Promise<T> {
    const url = new URL(route, this.baseUrl);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = https.request(url, {
        method,
        rejectUnauthorized: false,
        headers: {
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const statusCode = res.statusCode ?? 500;
          const text = Buffer.concat(chunks).toString("utf8");
          let data: unknown = {};
          if (text) {
            try {
              data = JSON.parse(text);
            } catch {
              reject(new Error(statusCode >= 400 ? `HTTP ${statusCode}` : "Invalid JSON response"));
              return;
            }
          }
          if (statusCode >= 400) {
            reject(new Error(readHttpErrorMessage(data, `HTTP ${statusCode}`)));
            return;
          }
          resolve(data as T);
        });
      });
      req.on("error", reject);
      req.setTimeout(3_000, () => {
        req.destroy(new Error("Request timed out"));
      });
      if (payload) req.write(payload);
      req.end();
    });
  }
}
