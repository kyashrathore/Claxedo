import { execFile } from "node:child_process"
import { createHash, X509Certificate } from "node:crypto"
import fs from "node:fs/promises"
import { createServer } from "node:https"
import path from "node:path"
import { promisify } from "node:util"
import { forward, forwardUpgrade } from "./proxy"
import { listenOnLoopback } from "../../../harness/e2e/harness/ports"

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

function spkiHash(cert: Buffer) {
  const spki = new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" })
  return createHash("sha256").update(spki).digest("base64")
}

export async function startTlsFront(input: { port: number; daemonUrl: string; certDir: string }): Promise<TlsFront> {
  const daemon = new URL(input.daemonUrl)
  const certificate = await selfSignedCertificate(input.certDir)
  const server = createServer({ key: certificate.key, cert: certificate.cert }, (request, response) => forward(request, response, daemon))
  server.on("upgrade", (request, socket, head) => forwardUpgrade(request, socket, head, daemon))
  await listenOnLoopback(server, input.port)
  return {
    url: `https://127.0.0.1:${input.port}`,
    trust: { caPath: certificate.certPath, spki: spkiHash(certificate.cert) },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
