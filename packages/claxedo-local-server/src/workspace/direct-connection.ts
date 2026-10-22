/**
 * TLS to another machine's direct route, used only once the machine has
 * presented the key it reported: nothing, the bearer included, is written to
 * a socket before its SubjectPublicKeyInfo hashes to the pin. The certificate
 * is self-signed, so Node's chain check is off and the pin is the whole check.
 */

import { createHash, X509Certificate } from "node:crypto"
import { Agent, type AgentOptions, type ClientRequestArgs } from "node:http"
import type { Duplex } from "node:stream"
import { connect, type TLSSocket } from "node:tls"

export type DirectTarget = { address: string; port: number; spkiSha256: string }

/** No connection was made, so nothing was sent: the caller may send the request another way. */
export class DirectRouteUnreachable extends Error {
  constructor(readonly target: DirectTarget, reason: string) {
    super(`${target.address}:${target.port} did not answer as the machine it reported: ${reason}`)
    this.name = "DirectRouteUnreachable"
  }
}

function presentedPin(socket: TLSSocket): string | undefined {
  const raw = socket.getPeerCertificate(true).raw
  if (!raw) return undefined
  const spki = new X509Certificate(raw).publicKey.export({ type: "spki", format: "der" })
  return createHash("sha256").update(spki).digest("base64url")
}

export function pinnedConnection(target: DirectTarget, timeoutMs: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: target.address, port: target.port, rejectUnauthorized: false, noDelay: true, ALPNProtocols: ["http/1.1"] })
    const fail = (reason: string) => {
      clearTimeout(timer)
      socket.destroy()
      reject(new DirectRouteUnreachable(target, reason))
    }
    const timer = setTimeout(() => fail(`no TLS answer within ${timeoutMs} ms`), timeoutMs)
    socket.once("error", (error: Error) => fail(error.message))
    socket.once("secureConnect", () => {
      if (presentedPin(socket) !== target.spkiSha256) {
        fail("it presented another key")
        return
      }
      clearTimeout(timer)
      socket.removeAllListeners("error")
      resolve(socket)
    })
  })
}

/** Keeps a pinned connection open between requests; every socket in its pool was pinned before it entered. */
export class PinnedAgent extends Agent {
  constructor(private readonly target: DirectTarget, private readonly connectTimeoutMs: number, options: AgentOptions = {}) {
    super({ keepAlive: true, timeout: 20_000, ...options })
  }

  override createConnection(_options: ClientRequestArgs, ready?: (error: Error | null, stream: Duplex) => void): Duplex | undefined {
    // Node's asynchronous contract calls back with the error alone when no socket was made.
    const settle = ready as ((error: Error | null, stream?: Duplex) => void) | undefined
    pinnedConnection(this.target, this.connectTimeoutMs).then(
      (socket) => settle?.(null, socket),
      (error: Error) => settle?.(error),
    )
    return undefined
  }
}
