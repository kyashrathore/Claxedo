import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

export type TlsTrust = { caPath: string; spki: string }

export type TlsFront = { url: string; trust: TlsTrust; close(): Promise<void> }

export async function selfSignedCertificate(dir: string) {
  const key = path.join(dir, "front-key.pem")
  const cert = path.join(dir, "front-cert.pem")
  await promisify(execFile)("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "2",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
    "-keyout", key, "-out", cert,
  ])
  return { key: await fs.readFile(key), cert: await fs.readFile(cert), certPath: cert }
}
