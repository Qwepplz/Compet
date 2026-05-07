import { net } from "electron";

const MAX_REDIRECTS = 5;

interface MinimalFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export function electronNetFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  return request(input, init, 0) as Promise<Response>;
}

function request(input: RequestInfo | URL, init: RequestInit, redirectCount: number): Promise<MinimalFetchResponse> {
  return new Promise((resolve, reject) => {
    const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
    const clientRequest = net.request({ method: init.method ?? "GET", url: url.toString() });
    for (const [key, value] of Object.entries(normalizeHeaders(init.headers))) {
      clientRequest.setHeader(key, value);
    }

    clientRequest.on("response", (response) => {
      const status = response.statusCode;
      const location = response.headers.location;
      const redirectUrl = Array.isArray(location) ? location[0] : location;
      if (redirectUrl && status >= 300 && status < 400 && redirectCount < MAX_REDIRECTS) {
        (response as unknown as NodeJS.ReadableStream).resume?.();
        request(new URL(redirectUrl, url), init, redirectCount + 1).then(resolve, reject);
        return;
      }

      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          ok: status >= 200 && status < 300,
          status,
          text: async () => body,
          json: async () => JSON.parse(body) as unknown,
        });
      });
    });

    clientRequest.on("error", reject);
    attachAbortSignal(clientRequest, init.signal, reject);
    clientRequest.end();
  });
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (Array.isArray(headers)) return Object.fromEntries(headers.map(([key, value]) => [key, value]));
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const normalized: Record<string, string> = {};
    headers.forEach((value, key) => {
      normalized[key] = value;
    });
    return normalized;
  }
  return headers as Record<string, string>;
}

function attachAbortSignal(
  clientRequest: ReturnType<typeof net.request>,
  signal: AbortSignal | null | undefined,
  reject: (reason?: unknown) => void,
): void {
  if (!signal) return;
  if (signal.aborted) {
    clientRequest.abort();
    reject(new Error("Request aborted"));
    return;
  }
  signal.addEventListener("abort", () => {
    clientRequest.abort();
    reject(new Error("Request aborted"));
  }, { once: true });
}
