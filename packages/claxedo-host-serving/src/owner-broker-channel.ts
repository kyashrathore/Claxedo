/**
 * This machine's end of the channel its owner's desktop opens to it
 * (`owner-broker-wire.ts`): the desktop's broker, reachable for as long as the
 * desktop reaches this machine's direct listener.
 *
 * The desktop is admitted as the direct route admits it, by the owner's own
 * Runtime Access Token for a workspace this machine serves; the token's
 * standing is asked again on every offer, and the channel closes when the
 * token expires or the owner pauses this machine. A newer admitted channel
 * replaces the current one, which finishes the streams it carries.
 *
 * Whether a call goes here or to the hosted broker is decided per request by
 * the caller (`owner-broker-shim.ts`): only while the current channel offers
 * the call's provider.
 */

import http2, { type ClientHttp2Session, type IncomingHttpHeaders } from "node:http2"
import { STATUS_CODES, type IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { decodeJwt } from "jose"
import { bearerToken } from "@claxedo/helpers"
import { remoteWorkspaceSessionAccessPolicy } from "@claxedo/session-core"
import { admitOwnerRuntimeAccess, type RuntimeAccessAdmission } from "@claxedo/session-core/relay-host"
import { runtimeAccessAdmission } from "./direct-admission"
import {
  OWNER_BROKER_OFFER_PATH,
  OWNER_BROKER_PASS_HEADER,
  OWNER_BROKER_UPGRADE,
  carriedHeaders,
  pumpBody,
  receivedHeaders,
  streamedBody,
} from "./owner-broker-wire"

const OFFER_INTERVAL_MS = 5_000
/** An offer unanswered this long is a desktop that has gone (asleep, off the network), whatever TCP still believes. */
const OFFER_TIMEOUT_MS = 3_000
const STATE_UNAVAILABLE = "runtime_access_token_state_unavailable"
const SWITCHED = `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: ${OWNER_BROKER_UPGRADE}\r\n\r\n`

type Claims = Parameters<RuntimeAccessAdmission["active"]>[0]["claims"]

type Channel = {
  session: ClientHttp2Session
  socket: Duplex
  token: string
  claims: Claims
  providers: ReadonlySet<string>
  expiry?: ReturnType<typeof setTimeout>
  nextOffer?: ReturnType<typeof setTimeout>
}

export type OwnerBrokerRequest = {
  method: string
  path: string
  headers: Headers
  body: ReadableStream<Uint8Array> | null
  signal: AbortSignal
}

export type OwnerBrokerChannels = {
  /** The direct listener's upgrade at `OWNER_BROKER_PATH`. */
  upgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void
  /** While withheld (the owner paused this machine) every channel is closed and none is admitted. */
  withhold: (withheld: boolean) => void
  /** The pass the latest beat delivered, presented with every stream; nothing while the machine does not serve. */
  setPass: (pass: string | undefined) => void
  offers: (providerId: string) => boolean
  /**
   * The call over the current channel. Nothing when there was no channel to
   * send it on, so the caller may send it elsewhere; a channel that fails
   * after the call was sent throws, and the call is not sent twice.
   */
  forward: (request: OwnerBrokerRequest) => Promise<Response | undefined>
  close: () => void
}

function refuseChannel(socket: Duplex, status: number) {
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

function tokenWorkspace(token: string): string | undefined {
  try {
    const workspaceId = decodeJwt(token).workspace_id
    return typeof workspaceId === "string" && workspaceId ? workspaceId : undefined
  } catch {
    return undefined
  }
}

function channelUsable(channel: Channel | undefined): channel is Channel {
  return channel !== undefined && !channel.session.closed && !channel.session.destroyed
}

function streamResponseHead(stream: http2.ClientHttp2Stream): Promise<IncomingHttpHeaders> {
  return new Promise((resolve, reject) => {
    stream.once("response", resolve)
    stream.once("error", reject)
    stream.once("close", () => reject(new Error("the owner's desktop closed the call before answering")))
  })
}

async function askOffer(channel: Channel, pass: string | undefined): Promise<ReadonlySet<string>> {
  const stream = channel.session.request({ ":method": "GET", ":path": OWNER_BROKER_OFFER_PATH, ...(pass ? { [OWNER_BROKER_PASS_HEADER]: pass } : {}) }, { endStream: true })
  stream.setTimeout(OFFER_TIMEOUT_MS, () => stream.close(http2.constants.NGHTTP2_CANCEL))
  const head = await streamResponseHead(stream)
  const text = await new Response(streamedBody(stream)).text()
  if (Number(head[":status"]) !== 200) return new Set()
  const providers: unknown = JSON.parse(text).providers
  return new Set(Array.isArray(providers) ? providers.filter((id): id is string => typeof id === "string") : [])
}

export function createOwnerBrokerChannels(options: {
  hostId: string
  /** The control plane's published key set, as the direct listener verifies the owner's token. */
  runtimeAccessJwksUrl: string
  /** Asked whether the owner's token still stands; the address arrives on a beat. */
  sessionAuthorityUrl: () => string | undefined
  log?: (line: string) => void
  admission?: RuntimeAccessAdmission
}): OwnerBrokerChannels {
  const log = options.log ?? (() => undefined)
  const admission = options.admission ?? runtimeAccessAdmission({
    jwksUrl: options.runtimeAccessJwksUrl,
    policy: remoteWorkspaceSessionAccessPolicy({ url: options.sessionAuthorityUrl }),
  })
  const channels = new Set<Channel>()
  let current: Channel | undefined
  let withheld = false
  let closed = false
  let pass: string | undefined

  const drop = (channel: Channel) => {
    clearTimeout(channel.expiry)
    clearTimeout(channel.nextOffer)
    channels.delete(channel)
    if (current === channel) current = undefined
  }

  const end = (channel: Channel, reason: string) => {
    if (!channels.has(channel)) return
    log(`owner broker: the owner's desktop channel closed: ${reason}`)
    drop(channel)
    channel.session.destroy()
    channel.socket.destroy()
  }

  const refresh = async (channel: Channel) => {
    const state = await admission.active({ token: channel.token, claims: channel.claims })
      .catch(() => ({ active: false as const, code: STATE_UNAVAILABLE, message: "" }))
    if (!state.active && state.code !== STATE_UNAVAILABLE) return end(channel, "the owner's token no longer stands")
    try {
      const before = [...channel.providers].sort().join(", ")
      channel.providers = await askOffer(channel, pass)
      const after = [...channel.providers].sort().join(", ")
      if (after !== before) log(`owner broker: the owner's desktop serves ${after || "no providers"}`)
    } catch (error) {
      end(channel, `it stopped answering (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  const open = (socket: Duplex, head: Buffer, token: string, claims: Claims) => {
    if (withheld || closed) return refuseChannel(socket, 503)
    if (head.length > 0) socket.unshift(head)
    const session = http2.connect("http://owner-broker.invalid", { createConnection: () => socket })
    const channel: Channel = { session, socket, token, claims, providers: new Set() }
    session.on("error", () => undefined)
    session.once("close", () => {
      if (channels.has(channel)) end(channel, "the connection ended")
    })
    const previous = current
    channels.add(channel)
    current = channel
    previous?.session.close()
    channel.expiry = setTimeout(() => end(channel, "the owner's token expired"), Math.max(0, claims.exp * 1000 - Date.now()))
    const tick = () => {
      void refresh(channel).finally(() => {
        if (channels.has(channel)) channel.nextOffer = setTimeout(tick, OFFER_INTERVAL_MS)
      })
    }
    tick()
    log("owner broker: the owner's desktop connected")
  }

  return {
    upgrade: (request, socket, head) => {
      socket.on("error", () => socket.destroy())
      if (withheld || closed) return refuseChannel(socket, 503)
      if (request.headers.upgrade?.toLowerCase() !== OWNER_BROKER_UPGRADE) return refuseChannel(socket, 400)
      const token = bearerToken(request.headers.authorization)
      const workspaceId = token ? tokenWorkspace(token) : undefined
      if (!token || !workspaceId) return refuseChannel(socket, 401)
      void admitOwnerRuntimeAccess(token, admission, { workspaceId, hostId: options.hostId }).then((admitted) => {
        if (!admitted.admitted) {
          log(`owner broker: refused a channel: ${admitted.code}`)
          return refuseChannel(socket, admitted.status)
        }
        socket.write(SWITCHED, () => open(socket, head, token, admitted.claims))
      }, () => refuseChannel(socket, 503))
    },
    withhold: (next) => {
      withheld = next
      if (next) for (const channel of channels) end(channel, "the owner paused this machine")
    },
    setPass: (next) => {
      pass = next
    },
    offers: (providerId) => channelUsable(current) && current.providers.has(providerId),
    forward: async (request) => {
      const channel = current
      if (!channelUsable(channel) || !pass) return undefined
      const stream = channel.session.request({
        ...carriedHeaders(request.headers),
        ":method": request.method,
        ":path": request.path,
        [OWNER_BROKER_PASS_HEADER]: pass,
      }, { endStream: request.body === null })
      const cancel = () => stream.close(http2.constants.NGHTTP2_CANCEL)
      request.signal.addEventListener("abort", cancel, { once: true })
      stream.once("close", () => request.signal.removeEventListener("abort", cancel))
      if (request.body) void pumpBody(request.body, stream).catch((error: unknown) => stream.destroy(error instanceof Error ? error : undefined))
      const head = await streamResponseHead(stream)
      const status = Number(head[":status"])
      const bodyless = request.method === "HEAD" || status === 204 || status === 304
      if (bodyless) stream.resume()
      return new Response(bodyless ? null : streamedBody(stream), { status, headers: receivedHeaders(head) })
    },
    close: () => {
      closed = true
      for (const channel of channels) end(channel, "this machine is stopping")
    },
  }
}
