/**
 * The desktop's end of the owner broker channel
 * (`@claxedo/host-serving/owner-broker-wire`): while this daemon carries the
 * owner's direct route to a `claxedo connect` machine, it also dials that
 * machine, pinned to the key it reported, upgrades the connection with the
 * owner's Runtime Access Token, and serves this desktop's broker on it as an
 * HTTP/2 server. The machine's model calls then spend this desktop's accounts
 * here, and the key never leaves this process.
 *
 * Nothing listens on this desktop for it. The channel exists only while the
 * renderer is carrying the machine's direct route here: its tokens are the
 * ones the renderer's direct requests present, and it ends with the last of
 * them, with a pause or a stop on the machine, or when the owner signs out.
 *
 * Every call on the channel carries the machine's owner broker pass, the
 * control plane's word from the machine's latest beat that the hosted broker
 * would admit it. A pass that does not verify against the plane's published
 * key set, has lapsed, or names another machine, key or owner than this
 * channel's is refused, so a machine revoked or paused is refused here within
 * a minute even if it keeps the channel open.
 */

import http2, { type IncomingHttpHeaders, type ServerHttp2Session, type ServerHttp2Stream } from "node:http2"
import { request as httpRequest } from "node:http"
import type { Duplex } from "node:stream"
import type { TLSSocket } from "node:tls"
import { createRemoteJWKSet, decodeJwt, type JWTVerifyGetKey } from "jose"
import type { CredentialSnapshot } from "@claxedo/agent-runtime-contract"
import { verifyOwnerBrokerPass, type OwnerBrokerPass } from "@claxedo/server-core/credentials/owner-broker-pass"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import {
  OWNER_BROKER_OFFER_PATH,
  OWNER_BROKER_PASS_HEADER,
  OWNER_BROKER_PATH,
  OWNER_BROKER_PROVIDER_PREFIX,
  OWNER_BROKER_UPGRADE,
  carriedHeaders,
  pumpBody,
  receivedHeaders,
  streamedBody,
} from "@claxedo/host-serving/owner-broker-wire"
import { pinnedConnection, type DirectTarget } from "./direct-connection"

const log = Log.create({ service: "owner-broker" })

const CONNECT_TIMEOUT_MS = 3_000
/** The machine asks the control plane whether the token stands before it answers. */
const UPGRADE_TIMEOUT_MS = 15_000
/** A token closer to its end than this opens no channel: the machine would close it at once. */
const MIN_TOKEN_LIFE_MS = 60_000
/** A newer token opens the channel that replaces the current one this long before the current one's token ends. */
const RENEW_BEFORE_MS = 5 * 60_000
const RETRY_MS = { first: 1_000, max: 5_000 }
const ROWS_HELD_MS = 10_000
const PASS_CLOCK_TOLERANCE_MS = 30_000
/** Verdicts held by pass text; a machine is minted a new pass every beat, so the cache is emptied rather than aged. */
const HELD_PASSES = 64

export type OwnerBrokerRow = { baseUrl: string; placeholder: string }

export type OwnerBrokerDialer = {
  /** The owner's token for a workspace on the machine at `target`, as a direct request presented it. */
  offer: (input: { target: DirectTarget; token: string }) => void
  /** Close every channel and forget every machine and token, as when the owner signs out. */
  forget: () => void
}

type Held = { value: string; expiresAt: number; hostId: string; userId: string }
type Served = { session: ServerHttp2Session; token: Held; target: DirectTarget }
type Machine = {
  target: DirectTarget
  token?: Held
  refused?: string
  /** The last way dialing failed, so a machine refusing while paused is logged once rather than every retry. */
  failure?: number | "unreachable"
  latest?: Served
  sessions: Set<ServerHttp2Session>
  dialing: boolean
  retry?: ReturnType<typeof setTimeout>
  attempt: number
}

/** The binding grain a machine's calls are bound under in this desktop's broker; no workspace id has this shape. */
export function ownerBrokerWorkspace(hostId: string) {
  return `owner-broker:${hostId}`
}

/** This desktop's own bound accounts in a projection, by provider. */
export function ownerBrokerRows(snapshot: CredentialSnapshot): Record<string, OwnerBrokerRow> {
  const own = snapshot.accounts[snapshot.machineOwnerUserId] ?? {}
  return Object.fromEntries(Object.entries(own).flatMap(([providerId, row]): [string, OwnerBrokerRow][] =>
    "placeholder" in row && typeof row.placeholder === "string" ? [[providerId, { baseUrl: row.baseUrl, placeholder: row.placeholder }]] : []))
}

function heldToken(value: string): Held | undefined {
  try {
    const claims = decodeJwt(value)
    const { exp, host_id: hostId, user_id: userId } = claims
    if (typeof exp !== "number" || typeof hostId !== "string" || typeof userId !== "string") return undefined
    return { value, expiresAt: exp * 1000, hostId, userId }
  } catch {
    return undefined
  }
}

function refuseStream(stream: ServerHttp2Stream, status: number, code: string, message: string) {
  if (stream.destroyed || stream.headersSent) return
  stream.respond({ ":status": status, "content-type": "application/json" })
  stream.end(JSON.stringify({ error: { code, message } }))
}

function upgrade(socket: TLSSocket, target: DirectTarget, token: string): Promise<{ switched: Duplex } | { refused: number }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      createConnection: () => socket,
      method: "GET",
      path: OWNER_BROKER_PATH,
      headers: {
        host: `${target.address.includes(":") ? `[${target.address}]` : target.address}:${target.port}`,
        connection: "Upgrade",
        upgrade: OWNER_BROKER_UPGRADE,
        authorization: `Bearer ${token}`,
      },
    })
    request.setTimeout(UPGRADE_TIMEOUT_MS, () => request.destroy(new Error(`no answer within ${UPGRADE_TIMEOUT_MS} ms`)))
    request.once("upgrade", (_answer, switched, head) => {
      request.setTimeout(0)
      if (head.length > 0) switched.unshift(head)
      resolve({ switched })
    })
    request.once("response", (answer) => {
      answer.resume()
      socket.destroy()
      resolve({ refused: answer.statusCode ?? 502 })
    })
    request.once("error", (error) => {
      socket.destroy()
      reject(error)
    })
    request.end()
  })
}

export function createOwnerBrokerDialer(input: {
  /** The control plane's published key set, which signs the machines' passes. */
  jwksUrl: string
  /** This desktop's bound accounts for one machine (`ownerBrokerWorkspace`). */
  project: (hostId: string) => Promise<Record<string, OwnerBrokerRow>>
  /** This desktop's broker, in process. */
  broker: (request: Request) => Promise<Response>
  connect?: (target: DirectTarget, timeoutMs: number) => Promise<TLSSocket>
  keySet?: JWTVerifyGetKey
  now?: () => number
}): OwnerBrokerDialer {
  const now = input.now ?? Date.now
  const connect = input.connect ?? pinnedConnection
  let keySet = input.keySet
  const machines = new Map<string, Machine>()
  const passes = new Map<string, Promise<OwnerBrokerPass | undefined>>()
  const rows = new Map<string, { at: number; rows: Promise<Record<string, OwnerBrokerRow>> }>()

  const rowsFor = (hostId: string) => {
    const held = rows.get(hostId)
    if (held && now() - held.at < ROWS_HELD_MS) return held.rows
    const fresh = { at: now(), rows: input.project(hostId) }
    fresh.rows.catch(() => rows.delete(hostId))
    rows.set(hostId, fresh)
    return fresh.rows
  }

  const admittedPass = async (served: Served, header: string | string[] | undefined) => {
    if (typeof header !== "string" || !header) return undefined
    if (passes.size >= HELD_PASSES && !passes.has(header)) passes.clear()
    keySet ??= createRemoteJWKSet(new URL(input.jwksUrl))
    const verdict = passes.get(header) ?? verifyOwnerBrokerPass(header, keySet, { now })
    passes.set(header, verdict)
    const pass = await verdict
    if (!pass || pass.expiresAt + PASS_CLOCK_TOLERANCE_MS <= now()) return undefined
    const { token, target } = served
    return pass.hostId === token.hostId && pass.ownerUserId === token.userId && pass.spkiSha256 === target.spkiSha256 ? pass : undefined
  }

  const answer = async (served: Served, stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
    if (!await admittedPass(served, headers[OWNER_BROKER_PASS_HEADER])) {
      return refuseStream(stream, 403, "owner_broker_pass_refused", "The machine's pass from the control plane is missing, lapsed or not its own")
    }
    const path = headers[":path"] ?? "/"
    const method = headers[":method"] ?? "GET"
    const bound = await rowsFor(served.token.hostId)
    if (path === OWNER_BROKER_OFFER_PATH) {
      stream.respond({ ":status": 200, "content-type": "application/json" })
      return stream.end(JSON.stringify({ providers: Object.keys(bound).sort() }))
    }
    const match = path.startsWith(OWNER_BROKER_PROVIDER_PREFIX) ? /^([^/?]+)(.*)$/.exec(path.slice(OWNER_BROKER_PROVIDER_PREFIX.length)) : null
    const row = match ? bound[decodeURIComponent(match[1])] : undefined
    if (!match || !row) return refuseStream(stream, 403, "provider_not_offered", "This desktop serves no account for that provider")
    const forwarded = receivedHeaders(headers)
    forwarded.set("authorization", `Bearer ${row.placeholder}`)
    const cancelled = new AbortController()
    stream.once("close", () => cancelled.abort())
    const bodyless = method === "GET" || method === "HEAD"
    const response = await input.broker(new Request(`${row.baseUrl}${match[2] || "/"}`, {
      method,
      headers: forwarded,
      ...(bodyless ? {} : { body: streamedBody(stream), duplex: "half" }),
      signal: cancelled.signal,
    } as RequestInit))
    if (stream.destroyed) return await response.body?.cancel()
    stream.respond({ ":status": response.status, ...carriedHeaders(response.headers) }, { endStream: !response.body })
    if (response.body) await pumpBody(response.body, stream)
  }

  const retryLater = (key: string, machine: Machine) => {
    if (machine.retry || !machines.has(key)) return
    const delay = Math.min(RETRY_MS.max, RETRY_MS.first * 2 ** machine.attempt)
    machine.attempt += 1
    machine.retry = setTimeout(() => {
      machine.retry = undefined
      ensure(key, machine)
    }, delay)
  }

  const serve = (key: string, machine: Machine, socket: Duplex, token: Held) => {
    const session = http2.performServerHandshake(socket)
    const served: Served = { session, token, target: machine.target }
    machine.latest = served
    machine.sessions.add(session)
    machine.attempt = 0
    machine.failure = undefined
    session.on("error", () => undefined)
    session.on("stream", (stream, headers) => {
      stream.on("error", () => undefined)
      void answer(served, stream, headers).catch((error: unknown) => {
        if (!stream.destroyed) log.warn("a call from a connected machine failed in this desktop's broker", { error: String(error) })
        refuseStream(stream, 502, "owner_broker_failed", "This desktop's broker could not answer the call")
        stream.destroy()
      })
    })
    session.once("close", () => {
      machine.sessions.delete(session)
      if (machine.latest !== served) return
      machine.latest = undefined
      log.info("a connected machine's broker channel closed", { hostId: token.hostId })
      retryLater(key, machine)
    })
    log.info("serving a connected machine its owner's accounts", { hostId: token.hostId, address: machine.target.address })
  }

  const dial = async (key: string, machine: Machine, token: Held) => {
    machine.dialing = true
    try {
      const answered = await upgrade(await connect(machine.target, CONNECT_TIMEOUT_MS), machine.target, token.value)
      if ("switched" in answered) return serve(key, machine, answered.switched, token)
      if (machine.failure !== answered.refused) log.info("a connected machine refused this desktop's broker channel", { hostId: token.hostId, status: answered.refused })
      machine.failure = answered.refused
      if (answered.refused === 401 || answered.refused === 403) machine.refused = token.value
      else retryLater(key, machine)
    } catch (error) {
      if (machine.failure !== "unreachable") log.info("a connected machine's broker channel could not be opened", { hostId: token.hostId, error: String(error) })
      machine.failure = "unreachable"
      retryLater(key, machine)
    } finally {
      machine.dialing = false
    }
  }

  const ensure = (key: string, machine: Machine) => {
    const token = machine.token
    if (!token || token.value === machine.refused || token.expiresAt - now() < MIN_TOKEN_LIFE_MS) return
    if (machine.dialing || machine.retry) return
    const latest = machine.latest
    if (latest && !latest.session.closed && !latest.session.destroyed) {
      if (latest.token.expiresAt - now() > RENEW_BEFORE_MS || token.expiresAt <= latest.token.expiresAt) return
    }
    void dial(key, machine, token)
  }

  return {
    offer: ({ target, token }) => {
      const key = `${target.spkiSha256}:${target.port}`
      const machine = machines.get(key) ?? { target, sessions: new Set(), dialing: false, attempt: 0 }
      machines.set(key, machine)
      machine.target = target
      if (token !== machine.token?.value) {
        const held = heldToken(token)
        if (held && held.expiresAt > (machine.token?.expiresAt ?? 0)) machine.token = held
      }
      ensure(key, machine)
    },
    forget: () => {
      for (const machine of machines.values()) {
        clearTimeout(machine.retry)
        for (const session of machine.sessions) session.destroy()
      }
      machines.clear()
      passes.clear()
      rows.clear()
    },
  }
}
