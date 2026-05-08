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
  const url = new URL(options.route, options.baseUrl);
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const createResponseError = options.createResponseError ?? ((message: string) => new Error(message));

  return new Promise((resolve, reject) => {
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
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const statusCode = res.statusCode ?? 500;
        const text = Buffer.concat(chunks).toString("utf8");
        let data: unknown = {};
        if (text) {
          try {
            data = JSON.parse(text);
          } catch {
            reject(createResponseError(statusCode >= 400 ? `HTTP ${statusCode}` : "Invalid JSON response", statusCode));
            return;
          }
        }
        if (statusCode >= 400) {
          reject(createResponseError(readHttpErrorMessage(data, `HTTP ${statusCode}`), statusCode));
          return;
        }
        resolve(data as T);
      });
    });
    req.on("error", reject);
    req.setTimeout(options.timeoutMs, () => {
      req.destroy(new Error(options.timeoutMessage ?? `Request timeout after ${options.timeoutMs}ms`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}
