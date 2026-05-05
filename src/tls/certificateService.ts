import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import selfsigned from "selfsigned";
import { pathExists } from "../storage/jsonFile.js";

const CERT_FILE = "server-cert.pem";
const KEY_FILE = "server-key.pem";

export interface ServerCertificate {
  certPath: string;
  keyPath: string;
  certPem: string;
  keyPem: string;
  fingerprintSha256: string;
}

export async function ensureServerCertificate(certDir: string): Promise<ServerCertificate> {
  await mkdir(certDir, { recursive: true });
  const certPath = path.join(certDir, CERT_FILE);
  const keyPath = path.join(certDir, KEY_FILE);

  if (!(await pathExists(certPath)) || !(await pathExists(keyPath))) {
    const notAfterDate = new Date();
    notAfterDate.setDate(notAfterDate.getDate() + 3650);
    const generated = await selfsigned.generate([{ name: "commonName", value: "Compet Match Server" }], {
      algorithm: "sha256",
      keySize: 2048,
      notAfterDate,
    });
    await writeFile(certPath, generated.cert, "utf8");
    await writeFile(keyPath, generated.private, "utf8");
  }

  const certPem = await readFile(certPath, "utf8");
  const keyPem = await readFile(keyPath, "utf8");
  return { certPath, keyPath, certPem, keyPem, fingerprintSha256: fingerprintCertificate(certPem) };
}

function fingerprintCertificate(certPem: string): string {
  const base64 = certPem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, "");
  const der = Buffer.from(base64, "base64");
  return createHash("sha256")
    .update(der)
    .digest("hex")
    .toUpperCase()
    .match(/.{2}/g)!
    .join(":");
}
