import https from "node:https";

export interface JsonRequestOptions {
  baseUrl: string;
  method: string;
  route: string;
  body?: unknown;
  token?: string;
  timeoutMs: number;
  timeoutMessage?: string;
  createResponseError?: (message: string, statusCode: number) => Error;
}

export class HttpRequestTimeoutError extends Error {
  readonly code = "ETIMEDOUT";

  constructor(message: string) {
    super(message);
    this.name = "HttpRequestTimeoutError";
  }
}

const sharedHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1_000,
  maxSockets: 64,
});

function readHttpErrorMessage(data: unknown, fallback: string): string {
  if (typeof data !== "object" || data === null) return fallback;
  const envelope = data as { message?: unknown; error?: { message?: unknown } };
  if (typeof envelope.message === "string") return envelope.message;
  if (typeof envelope.error?.message === "string") return envelope.error.message;
  return fallback;
}

export function requestJson<T>(options: JsonRequestOptions): Promise<T> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    return Promise.reject(new RangeError("timeoutMs must be a finite positive number"));
  }

  const url = new URL(options.route, options.baseUrl);
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const createResponseError = options.createResponseError ?? ((message: string) => new Error(message));

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const clearRequestTimeout = () => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
    };
    const settleResolve = (value: T) => {
      if (settled) return;
      settled = true;
      clearRequestTimeout();
      resolve(value);
    };
    const settleReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearRequestTimeout();
      reject(error);
    };

    const requestDeadline = performance.now() + options.timeoutMs;
    const req = https.request(url, {
      method: options.method,
      agent: sharedHttpsAgent,
      rejectUnauthorized: false,
      headers: {
        ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => {
        if (!settled) chunks.push(Buffer.from(chunk));
      });
      res.on("end", () => {
        if (settled) return;
        const statusCode = res.statusCode ?? 500;
        const text = Buffer.concat(chunks).toString("utf8");
        let data: unknown = {};
        if (text) {
          try {
            data = JSON.parse(text);
          } catch {
            settleReject(createResponseError(statusCode >= 400 ? `HTTP ${statusCode}` : "Invalid JSON response", statusCode));
            return;
          }
        }
        if (statusCode >= 400) {
          settleReject(createResponseError(readHttpErrorMessage(data, `HTTP ${statusCode}`), statusCode));
          return;
        }
        settleResolve(data as T);
      });
    });
    req.on("error", settleReject);
    timeoutTimer = setTimeout(() => {
      const error = new HttpRequestTimeoutError(options.timeoutMessage ?? `Request timeout after ${options.timeoutMs}ms`);
      settleReject(error);
      req.destroy(error);
    }, Math.max(0, requestDeadline - performance.now()));
    if (payload) req.write(payload);
    req.end();
  });
}
