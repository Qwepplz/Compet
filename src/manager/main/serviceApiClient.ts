import { requestJson } from "../../shared/httpJsonClient.js";
import type { AccountMatchDetail, AccountMatchHistory, AccountView, CreateAccountInput, LoginResult, MatchmakingOccupancy, UpdateAccountInput } from "../shared/types.js";

export class ServiceApiError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "ServiceApiError";
  }
}

export class ServiceApiClient {
  private token?: string;

  constructor(private readonly baseUrl: string) {}

  async health(): Promise<void> {
    await this.request("GET", "/health");
  }

  async matchmakingOccupancy(): Promise<MatchmakingOccupancy> {
    const response = await this.request<{ occupancy: MatchmakingOccupancy }>("GET", "/admin/matchmaking/occupancy");
    return response.occupancy;
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

  sessionToken(): string | undefined {
    return this.token;
  }

  setSessionToken(token: string | undefined): void {
    this.token = token;
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await this.request("POST", "/auth/change-password", { currentPassword, newPassword });
  }

  async accounts(): Promise<AccountView[]> {
    const response = await this.request<{ accounts: AccountView[] }>("GET", "/admin/accounts");
    return response.accounts;
  }

  accountMatchHistory(id: string, page: number): Promise<AccountMatchHistory> {
    return this.request("GET", `/admin/accounts/${encodeURIComponent(id)}/matches?page=${page}`);
  }

  accountMatchDetail(id: string, matchId: string): Promise<AccountMatchDetail> {
    return this.request("GET", `/admin/accounts/${encodeURIComponent(id)}/matches/${encodeURIComponent(matchId)}`);
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
      createResponseError: (message, statusCode) => new ServiceApiError(message, statusCode),
    });
  }
}
