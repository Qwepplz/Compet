import { requestJson, type JsonRequestOptions } from "../shared/httpJsonClient.js";

export class CliError extends Error {
  readonly code: string;
  constructor(code: string, readonly statusCode?: number) {
    const safeCode = /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : "operation_failed";
    super(safeCode);
    this.code = safeCode;
  }
}

export type CliJsonSender = <T>(input: JsonRequestOptions) => Promise<T>;

export class CliAdminClient {
  private token?: string;
  private active = false;
  constructor(private readonly baseUrl: string, private readonly send: CliJsonSender = requestJson) {}

  private async call<T>(method: string, route: string, body?: unknown, token = this.token): Promise<T> {
    try {
      return await this.send<T>({ baseUrl: this.baseUrl, method, route, body, token, timeoutMs: 3_000,
        createResponseError: (_message, status, code) => new CliError(code, status) });
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError("connection_failed");
    }
  }

  async request<T = unknown>(method: string, route: string): Promise<T> {
    if (!this.token) throw new CliError("authentication_required", 401);
    return this.call<T>(method, route);
  }

  async withSession<T>(username: string, password: string, operation: (api: CliAdminClient) => Promise<T>): Promise<T> {
    if (this.active) throw new CliError("authentication_in_progress", 409);
    this.active = true;
    let failed = false;
    try {
      const response = await this.call<{ token?: unknown; account?: { role?: unknown; mustChangePassword?: unknown } }>(
        "POST", "/auth/manager-login", { username, password });
      if (typeof response.token === "string" && response.token) this.token = response.token;
      if (!this.token || response.account?.role !== "admin") throw new CliError("authentication_failed", 403);
      if (response.account.mustChangePassword === true) throw new CliError("password_change_required", 403);
      return await operation(this);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      const token = this.token;
      this.token = undefined;
      try {
        if (token) {
          try { await this.call("POST", "/auth/logout", undefined, token); }
          catch (error) { if (!failed && (error as CliError).statusCode !== 401) throw new CliError("logout_failed"); }
        }
      } finally { this.active = false; }
    }
  }
}
