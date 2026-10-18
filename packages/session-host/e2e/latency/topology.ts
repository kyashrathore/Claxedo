import type { Readable } from "node:stream"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { exportPKCS8, exportSPKI, generateKeyPair, type GenerateKeyPairResult } from "jose"
import { Miniflare } from "miniflare"
import type { ProviderDirect } from "@claxedo/agent-runtime-contract"
import { mintRelayHostToken, mintRuntimeAccessToken } from "@claxedo/workspace-relay"
import { sessionHostId } from "@claxedo/workspace-relay-protocol"
import { delayedResponse, sleep, type ChunkTap } from "../../../harness/e2e/perf/pipes"
import { controlPlaneStandIn, OWNER, WORKSPACE_ID } from "../../src/test-support/control-plane"
import { bundleSessionHostWorker } from "../../src/test-support/session-host-worker"

const RELAY_WORKER = fileURLToPath(new URL("../../../workspace-relay/src/worker.ts", import.meta.url))
const AUTHORITY_URL = "https://control-plane.test/api/runtime-authority/session-authorize"
const COMPATIBILITY_DATE = "2026-07-22"

/** One-way latencies of the staging topology as seen from India, in milliseconds. */
export type Links = {
  /** Browser to the Cloudflare edge and the relay room (apac). */
  clientEdgeMs: number
  /** Relay room (apac) to the session's object (enam), also the room to the control plane (IAD). */
  roomDoMs: number
  /** The session's object (enam) to the control-plane Worker (IAD). */
  doCpMs: number
  /** The control plane's own time per request, on top of the link. */
  cpMs: number
  /** The session's object (enam) to the model vendor. */
  vendorMs: number
}

export const STAGING_LINKS: Links = { clientEdgeMs: 50, roomDoMs: 110, doCpMs: 5, cpMs: 50, vendorMs: 10 }

export type Scripts = { relay: string; sessionHost: string }

export async function bundleScripts(): Promise<Scripts> {
  const relay = await build({
    entryPoints: [RELAY_WORKER], bundle: true, format: "esm", platform: "neutral", target: "es2022", write: false,
    conditions: ["development", "workerd", "worker", "browser"], mainFields: ["module", "main"],
  })
  return { relay: relay.outputFiles[0].text, sessionHost: await bundleSessionHostWorker() }
}

/** The relay-side object the relay's `SESSION_HOST` binding names: it hands each request to the link. */
const PIPE_SCRIPT = `
export class SessionDO {
  constructor(state, env) { this.state = state; this.env = env }
  async fetch(request) {
    const headers = new Headers(request.headers)
    headers.set("x-pipe-root", this.state.id.name)
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text()
    return this.env.UPSTREAM.fetch(request.url, { method: request.method, headers, body, redirect: "manual" })
  }
}
export default { fetch() { return new Response("not found", { status: 404 }) } }
`

export type PipeRecord = { path: string; arrivedAt: number; answeredAt?: number; chunks: Array<{ at: number; text: string }> }

export type TopologyInput = {
  scripts: Scripts
  persist: string
  root: string
  links: Links
  vendor: { url: string; secret: string }
  /** The relay's target and revocation cache TTLs; absent, the relay's 10 s defaults. */
  relayCacheTtlMs?: number
  /** The keys and control plane of an earlier boot, so a rebooted workerd finds the session it registered and the leases it held. */
  world?: World
}

export type World = { signing: Keys; controlPlane: ReturnType<typeof controlPlaneStandIn> }

export type Topology = Awaited<ReturnType<typeof bootTopology>>

type Keys = { relayHost: GenerateKeyPairResult; runtimeAccess: GenerateKeyPairResult }

async function keys(): Promise<Keys> {
  return { relayHost: await generateKeyPair("EdDSA", { extractable: true }), runtimeAccess: await generateKeyPair("EdDSA", { extractable: true }) }
}

function account(vendor: { url: string; secret: string }): Record<string, ProviderDirect> {
  return { openai: { delivery: "direct", baseUrl: vendor.url, apiPath: "/v1", secret: vendor.secret, authKind: "api-key",
    account: { credentialId: "cred_openai_owner", providerId: "openai", label: "owner's OpenAI key", revision: 1 } } }
}

/**
 * Staging's path from a browser in India to a Pi session's object, in one
 * workerd: the real relay Worker and room, a link of `roomDoMs` to the real
 * session-host Worker, the control plane as the object sees it behind
 * `doCpMs + cpMs`, the relay's resolver behind `roomDoMs + cpMs`, and the
 * vendor at the caller's address. The client side of the edge link is the
 * `relay` and `direct` clients below.
 */
export async function bootTopology(input: TopologyInput) {
  const { links } = input
  const signing = input.world?.signing ?? await keys()
  const resolverCalls: Array<{ path: string; at: number }> = []
  const pipe: PipeRecord[] = []
  const stderr: string[] = []
  const controlPlane = input.world?.controlPlane ?? controlPlaneStandIn({
    root: input.root, relayHostKey: signing.relayHost.publicKey, runtimeAccessKey: signing.runtimeAccess.privateKey,
    accounts: () => ({ [OWNER]: account(input.vendor) }), plugins: () => ({ harnessLaunch: {}, mcp: {} }),
    machine: () => ({ relayUrl: "http://127.0.0.1:1", directory: "/workspace" }),
    workspaceSessions: () => [], sessionHost: () => () => { throw new Error("The latency rig has no first-party MCP") },
  })
  const world: World = { signing, controlPlane }
  const cpCalls: Array<{ path: string; at: number; ms: number }> = []
  const controlPlaneLink = async (request: Request) => {
    const at = performance.now()
    const body = await request.text()
    const action = (JSON.parse(body || "{}") as { action?: unknown }).action
    await sleep(links.doCpMs + links.cpMs)
    const response = await controlPlane.fetch(new Request(request.url, { method: request.method, headers: request.headers, body }))
    await sleep(links.doCpMs)
    cpCalls.push({ path: `${new URL(request.url).pathname.split("/").pop()}${typeof action === "string" ? `:${action}` : ""}`, at, ms: performance.now() - at })
    return response
  }
  const resolver = async (request: Request) => {
    const url = new URL(request.url)
    resolverCalls.push({ path: url.pathname, at: performance.now() })
    await sleep(2 * links.roomDoMs + links.cpMs)
    if (request.headers.get("authorization") !== "Bearer resolver-token") return new Response("unauthorized", { status: 401 })
    if (url.pathname === "/internal/relay/target") {
      return Response.json({ workspaceId: url.searchParams.get("workspaceId"), hostId: url.searchParams.get("hostId"), baseUrl: "", backing: "durable-object" })
    }
    if (url.pathname === "/internal/relay/revocation") return Response.json({ active: true })
    return new Response("not found", { status: 404 })
  }
  let miniflare: Miniflare | undefined
  const sessionHost = async () => {
    if (!miniflare) throw new Error("workerd is not up")
    return miniflare.getDurableObjectNamespace("SESSION_HOST", "session-host")
  }
  const link = async (request: Request) => {
    const record: PipeRecord = { path: new URL(request.url).pathname, arrivedAt: performance.now(), chunks: [] }
    pipe.push(record)
    const root = request.headers.get("x-pipe-root")
    if (!root) return new Response("no object", { status: 500 })
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text()
    await sleep(links.roomDoMs)
    const namespace = await sessionHost()
    const upstream = await namespace.get(namespace.idFromName(root)).fetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers), ...(body === undefined ? {} : { body }) } as never) as unknown as Response
    record.answeredAt = performance.now()
    const decoder = new TextDecoder()
    const tap: ChunkTap = (chunk, at) => { record.chunks.push({ at, text: decoder.decode(chunk, { stream: true }) }) }
    return await delayedResponse(upstream, links.roomDoMs, tap)
  }
  miniflare = new Miniflare({
    durableObjectsPersist: input.persist,
    handleRuntimeStdio: (stdout: Readable, err: Readable) => {
      stdout.resume()
      err.on("data", (chunk: Buffer) => stderr.push(chunk.toString()))
    },
    workers: [
      {
        name: "relay", compatibilityDate: COMPATIBILITY_DATE,
        modules: [{ type: "ESModule", path: "relay.mjs", contents: input.scripts.relay }],
        durableObjects: {
          WORKSPACE_RELAY_ROOM: { className: "WorkspaceRelayRoom", useSQLite: true },
          SESSION_HOST: { className: "SessionDO", scriptName: "pipe" },
        },
        bindings: {
          CLAXEDO_RELAY_RESOLVER_URL: "https://control-plane.test/internal/relay",
          CLAXEDO_RELAY_RESOLVER_TOKEN: "resolver-token",
          CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(signing.runtimeAccess.publicKey),
          CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM: await exportPKCS8(signing.relayHost.privateKey),
          ...(input.relayCacheTtlMs === undefined ? {} : {
            CLAXEDO_RELAY_TARGET_CACHE_TTL_MS: String(input.relayCacheTtlMs),
            CLAXEDO_RELAY_REVOCATION_CACHE_TTL_MS: String(input.relayCacheTtlMs),
          }),
        },
        outboundService: resolver as never,
      },
      {
        name: "pipe", compatibilityDate: COMPATIBILITY_DATE,
        modules: [{ type: "ESModule", path: "pipe.mjs", contents: PIPE_SCRIPT }],
        durableObjects: { SESSION_HOST: { className: "SessionDO" } },
        serviceBindings: { UPSTREAM: link as never },
      },
      {
        name: "session-host", compatibilityDate: COMPATIBILITY_DATE, compatibilityFlags: ["nodejs_compat"],
        modules: [{ type: "ESModule", path: "session-host.mjs", contents: input.scripts.sessionHost }],
        durableObjects: { SESSION_HOST: { className: "SessionDO", useSQLite: true } },
        serviceBindings: { CONTROL_PLANE: controlPlaneLink as never },
        bindings: {
          WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL: AUTHORITY_URL,
          WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM: await exportSPKI(signing.relayHost.publicKey),
        },
      },
    ],
  })
  await miniflare.ready
  const rat = await mintRuntimeAccessToken({
    principalKind: "user", actorId: OWNER, userId: OWNER, actorKind: "human", orgId: "org_1", workspaceId: WORKSPACE_ID,
    hostId: sessionHostId(input.root), role: "editor", sessionId: input.root,
  }, signing.runtimeAccess.privateKey, "EdDSA")
  const relayHostToken = () => mintRelayHostToken({
    principalKind: "user", actorId: OWNER, userId: OWNER, actorKind: "human", orgId: "org_1", workspaceId: WORKSPACE_ID,
    hostId: sessionHostId(input.root), role: "editor", sessionId: input.root, backing: "durable-object", parentJti: `rat_${crypto.randomUUID()}`,
  }, signing.relayHost.privateKey, "EdDSA")
  const mf = miniflare
  return {
    root: input.root,
    world,
    controlPlane,
    cpCalls,
    resolverCalls,
    pipe,
    stderr: () => stderr.join(""),
    /** The browser's view: the edge link, then the relay at the edge. */
    relay: async (path: string, init: RequestInit = {}): Promise<Response> => {
      await sleep(links.clientEdgeMs)
      const headers = new Headers(init.headers)
      headers.set("authorization", `Bearer ${rat}`)
      if (init.body !== undefined) headers.set("content-type", "application/json")
      const response = await mf.dispatchFetch(`https://relay.test/workspaces/${WORKSPACE_ID}${path}`, { ...init, headers } as never) as unknown as Response
      return await delayedResponse(response, links.clientEdgeMs)
    },
    /** The same object over one link from the browser, with no relay in between: what a direct path would cost. */
    direct: async (path: string, init: RequestInit = {}): Promise<Response> => {
      const oneWay = links.clientEdgeMs + links.roomDoMs
      await sleep(oneWay)
      const headers = new Headers(init.headers)
      headers.set("authorization", `Bearer ${await relayHostToken()}`)
      headers.set("x-workspace-id", WORKSPACE_ID)
      headers.set("x-forwarded-by", "workspace-relay")
      if (init.body !== undefined) headers.set("content-type", "application/json")
      const namespace = await sessionHost()
      const response = await namespace.get(namespace.idFromName(input.root)).fetch(`https://session-host.invalid${path}`, { ...init, headers: Object.fromEntries(headers) } as never) as unknown as Response
      return await delayedResponse(response, oneWay)
    },
    dispose: () => mf.dispose(),
  }
}
