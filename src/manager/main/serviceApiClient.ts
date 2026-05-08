import { requestJson } from "../../shared/httpJsonClient.js";
import type { AccountView, CreateAccountInput, LoginResult, UpdateAccountInput } from "../shared/types.js";

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
    return requestJson<T>({
      baseUrl: this.baseUrl,
      method,
      route,
      body,
      token: this.token,
      timeoutMs: 3_000,
      timeoutMessage: "Request timed out",
    });
  }
}
