import { createHash, randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";

function updateError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export async function fetchUpdateResponse(url: string, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(url, { redirect: "error", ...(signal === undefined ? {} : { signal }) });
  if (!response.ok) throw updateError("update_server_error", `Update server returned ${response.status}`);
  return response;
}

export async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  return (await (await fetchUpdateResponse(url, signal)).json()) as T;
}

export function ensureSameOrigin(baseUrl: string, nextUrl: string): void {
  const base = new URL(baseUrl), next = new URL(nextUrl);
  if (base.origin !== next.origin) throw updateError("update_manifest_origin_invalid", "Update manifest URL must use the update source origin");
}

export function awaitIntegrityOperation<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then((value) => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) reject(signal.reason);
      else resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

export async function downloadFile(
  url: string,
  filePath: string,
  sha256: string,
  size: number,
  signal?: AbortSignal,
  onChunk?: (bytes: number) => void,
): Promise<void> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason ?? updateError("update_cancelled", "Update cancelled"));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  const resetInactivity = () => {
    if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => controller.abort(updateError("update_download_timeout", "Download stalled")), 30000);
  };
  const temporary = filePath + "." + randomUUID() + ".tmp";
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let completed = false;
  try {
    resetInactivity();
    const response = await awaitIntegrityOperation(
      () => fetch(url, { redirect: "error", signal: controller.signal }),
      controller.signal,
    );
    if (!response.ok || !response.body) {
      throw updateError("update_download_failed", "Unable to download managed file");
    }
    handle = await open(temporary, "wx");
    reader = response.body.getReader();
    const hash = createHash("sha256");
    let received = 0;
    while (true) {
      const next = await awaitIntegrityOperation(() => reader!.read(), controller.signal);
      if (next.done) break;
      const bytes = next.value;
      received += bytes.byteLength;
      if (!Number.isSafeInteger(received) || received > size) {
        throw updateError("update_file_hash_mismatch", "Downloaded file exceeds its expected size");
      }
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await handle.write(bytes.subarray(offset));
        offset += result.bytesWritten;
      }
      hash.update(bytes);
      controller.signal.throwIfAborted();
      onChunk?.(bytes.byteLength);
      resetInactivity();
    }
    if (received !== size || hash.digest("hex").toUpperCase() !== sha256) {
      throw updateError("update_file_hash_mismatch", "Downloaded file does not match the release");
    }
    await handle.close();
    handle = undefined;
    controller.signal.throwIfAborted();
    await rename(temporary, filePath);
    completed = true;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason ?? error;
    throw error;
  } finally {
    if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
    signal?.removeEventListener("abort", onAbort);
    if (!completed && reader) void reader.cancel().catch(() => {});
    if (handle) await handle.close();
    if (!completed) await rm(temporary, { force: true });
  }
}
