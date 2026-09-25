import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import { createServer, type Server } from "node:https"
import path from "node:path"
import { promisify } from "node:util"
import { forward, forwardUpgrade } from "./proxy"

export type TlsFront = { url: string; close(): Promise<void> }

async function selfSignedCertificate(dir: string) {
  const key = path.join(dir, "front-key.pem")
  const cert = path.join(dir, "front-cert.pem")
  await promisify(execFile)("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "2",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
    "-keyout", key, "-out", cert,
  ])
  return { key: await fs.readFile(key), cert: await fs.readFile(cert) }
}

function listen(server: Server, port: number) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", resolve)
  })
}

export async function startTlsFront(input: { port: number; daemonUrl: string; certDir: string }): Promise<TlsFront> {
  const daemon = new URL(input.daemonUrl)
  const server = createServer(await selfSignedCertificate(input.certDir), (request, response) => forward(request, response, daemon))
  server.on("upgrade", (request, socket, head) => forwardUpgrade(request, socket, head, daemon))
  await listen(server, input.port)
  return {
    url: `https://127.0.0.1:${input.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
