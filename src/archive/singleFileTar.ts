import { createHash } from "node:crypto";

export interface ArchiveMetadata { birthtimeNs: string; mtimeNs: string }
export interface ArchiveFingerprint { size: number; sha256: string }
export interface ArchiveInspection extends ArchiveFingerprint { memberName: string; metadata: ArchiveMetadata }
const block = 512;
const paxLimit = 65536;
function invalid(): never { throw new Error("archive_tar_invalid"); }
function member(name: string): void {
  if (!name || name === "." || name === ".." || /[\/\\:\x00-\x1f\x7f]/.test(name)) throw new Error("archive_member_invalid");
}
function ns(value: string): bigint {
  if (!/^-?(?:0|[1-9]\d*)$/.test(value)) throw new Error("archive_metadata_invalid");
  return BigInt(value);
}
function seconds(value: string): string {
  const time = ns(value), negative = time < 0n, magnitude = negative ? -time : time;
  return (negative ? "-" : "") + magnitude / 1000000000n + "." + (magnitude % 1000000000n).toString().padStart(9, "0");
}
function nanos(value: string): string {
  if (!/^-?\d+(?:[.]\d{1,9})?$/.test(value)) return invalid();
  const negative = value.startsWith("-"), [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  const result = BigInt(whole!) * 1000000000n + BigInt(fraction.padEnd(9, "0"));
  return (negative ? -result : result).toString();
}
function pax(key: string, value: string): Buffer {
  const tail = " " + key + "=" + value + "\n";
  let length = Buffer.byteLength(tail) + 1;
  while (length !== Buffer.byteLength(tail) + String(length).length) length = Buffer.byteLength(tail) + String(length).length;
  return Buffer.from(length + tail);
}
function octal(header: Buffer, offset: number, width: number, value: number): void {
  const digits = value.toString(8);
  if (!Number.isSafeInteger(value) || value < 0 || digits.length >= width) throw new Error("archive_metadata_invalid");
  header.write(digits.padStart(width - 1, "0") + "\0", offset, width, "ascii");
}
function header(name: string, size: number, type: string): Buffer {
  const out = Buffer.alloc(block);
  out.write(name, 0, 100, "utf8");
  octal(out, 100, 8, 0o600); octal(out, 108, 8, 0); octal(out, 116, 8, 0);
  octal(out, 124, 12, size); octal(out, 136, 12, 0);
  out.fill(32, 148, 156); out.write(type, 156, 1);
  out.write("ustar\0", 257, 6, "ascii"); out.write("00", 263, 2);
  const checksum = out.reduce((a, b) => a + b, 0);
  out.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return out;
}
export async function* encodeSingleFileTar(input: {
  memberName: string; size: number; metadata: ArchiveMetadata; content: AsyncIterable<Uint8Array>;
}): AsyncIterable<Uint8Array> {
  member(input.memberName);
  if (!Number.isSafeInteger(input.size) || input.size < 0) throw new Error("archive_metadata_invalid");
  const control = Buffer.concat([
    pax("path", input.memberName), pax("size", String(input.size)),
    pax("mtime", seconds(input.metadata.mtimeNs)), pax("LIBARCHIVE.creationtime", seconds(input.metadata.birthtimeNs)),
  ]);
  if (control.length > paxLimit) throw new Error("archive_metadata_invalid");
  yield header("PaxHeader", control.length, "x");
  yield control;
  if (control.length % block) yield Buffer.alloc(block - control.length % block);
  yield header(Buffer.byteLength(input.memberName) <= 100 ? input.memberName : "file", input.size < 8589934592 ? input.size : 0, "0");
  let size = 0;
  for await (const chunk of input.content) {
    size += chunk.length;
    if (size > input.size) throw new Error("archive_source_changed");
    yield chunk;
  }
  if (size !== input.size) throw new Error("archive_source_changed");
  if (size % block) yield Buffer.alloc(block - size % block);
  yield Buffer.alloc(block * 2);
}
class Reader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private current: Uint8Array = new Uint8Array(0);
  private offset = 0;
  constructor(input: AsyncIterable<Uint8Array>) { this.iterator = input[Symbol.asyncIterator](); }
  async take(max: number): Promise<Uint8Array | null> {
    while (this.offset === this.current.length) {
      const next = await this.iterator.next();
      if (next.done) return null;
      this.current = next.value; this.offset = 0;
    }
    const part = this.current.subarray(this.offset, this.offset + max); this.offset += part.length;
    return part;
  }
  async exact(size: number): Promise<Buffer> {
    const result = Buffer.alloc(size); let offset = 0;
    while (offset < size) {
      const part = await this.take(size - offset); if (!part) return invalid();
      result.set(part, offset); offset += part.length;
    }
    return result;
  }
  async close(): Promise<void> { await this.iterator.return?.(); }
}
function number(header: Buffer, offset: number, length: number): number {
  const text = header.subarray(offset, offset + length).toString("ascii").replace(/\0.*$/s, "").trim();
  if (!/^[0-7]+$/.test(text)) return invalid();
  const value = parseInt(text, 8);
  if (!Number.isSafeInteger(value)) return invalid();
  return value;
}
function checkHeader(value: Buffer): void {
  const expected = number(value, 148, 8);
  const checksum = value.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
  if (expected !== checksum || !value.subarray(257, 265).equals(Buffer.from("ustar\0" + "00", "ascii"))) invalid();
}
function parsePax(bytes: Buffer): Map<string, string> {
  const result = new Map<string, string>(); let offset = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0 || space - offset > 6) return invalid();
    const digits = bytes.subarray(offset, space).toString("ascii");
    if (!/^[1-9]\d*$/.test(digits)) return invalid();
    const length = Number(digits);
    if (length <= space - offset + 2 || offset + length > bytes.length || bytes[offset + length - 1] !== 10) return invalid();
    const line = decoder.decode(bytes.subarray(space + 1, offset + length - 1)), equal = line.indexOf("=");
    if (equal < 1) return invalid();
    const key = line.slice(0, equal), value = line.slice(equal + 1);
    if (!["path", "size", "mtime", "LIBARCHIVE.creationtime"].includes(key) || result.has(key)) return invalid();
    result.set(key, value); offset += length;
  }
  if (result.size !== 4) return invalid();
  return result;
}
async function zeros(reader: Reader, count: number): Promise<void> {
  const bytes = await reader.exact(count); if (bytes.some(byte => byte !== 0)) invalid();
}
export async function inspectSingleFileTar(input: AsyncIterable<Uint8Array>): Promise<ArchiveInspection> {
  const reader = new Reader(input);
  try {
    const extended = await reader.exact(block); checkHeader(extended);
    const controlSize = number(extended, 124, 12);
    if (extended[156] !== 120 || controlSize < 1 || controlSize > paxLimit) return invalid();
    const fields = parsePax(await reader.exact(controlSize));
    if (controlSize % block) await zeros(reader, block - controlSize % block);
    const file = await reader.exact(block); checkHeader(file);
    if (file[156] !== 48 || file.subarray(157, 257).some(byte => byte !== 0)) return invalid();
    const memberName = fields.get("path")!;
    try { member(memberName); } catch { return invalid(); }
    const rawName = new TextDecoder("utf-8", { fatal: true }).decode(file.subarray(0, 100)).replace(/\0.*$/s, "");
    if (rawName !== (Buffer.byteLength(memberName) <= 100 ? memberName : "file") || file.subarray(345, 500).some(byte => byte !== 0)) return invalid();
    const sizeText = fields.get("size")!;
    if (!/^(?:0|[1-9]\d*)$/.test(sizeText)) return invalid();
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || number(file, 124, 12) !== (size < 8589934592 ? size : 0)) return invalid();
    const metadata = { birthtimeNs: nanos(fields.get("LIBARCHIVE.creationtime")!), mtimeNs: nanos(fields.get("mtime")!) };
    const hash = createHash("sha256"); let remaining = size;
    while (remaining > 0) {
      const part = await reader.take(Math.min(remaining, 65536)); if (!part) return invalid();
      hash.update(part); remaining -= part.length;
    }
    if (size % block) await zeros(reader, block - size % block);
    await zeros(reader, block * 2);
    let trailing = 0;
    for (;;) { const part = await reader.take(65536); if (!part) break; if (part.some(byte => byte !== 0)) invalid(); trailing += part.length; }
    if (trailing % block !== 0) return invalid();
    return { memberName, size, metadata, sha256: hash.digest("hex") };
  } catch (error) {
    if (error instanceof Error && error.message === "archive_tar_invalid") throw error;
    throw new Error("archive_tar_invalid", { cause: error });
  } finally { await reader.close(); }
}
