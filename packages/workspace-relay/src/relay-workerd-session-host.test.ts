import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import type { Miniflare } from "miniflare"
import { sessionHostId } from "@claxedo/workspace-relay-protocol"
import { mintRuntimeAccessToken, verifyRelayHostToken } from "./auth"
import { bootWorkerd, reapWorkerd } from "./workerd-fixture/boot"

const WORKSPACE_ID = "ws_session_host"
const ROOT = "ses_root"
const HOST_ID = sessionHostId(ROOT)
const COMPATIBILITY_DATE = "2025-05-01"

/**
 * The session-host Worker's place in the relay's world, and nothing more: a
 * `SessionDO` that reports what it was sent, streams an event stream, and
 * names the object the relay addressed. The relay under test is the real
 * bundled `worker.ts`.
 */
const SESSION_HOST_SCRIPT = `
export class SessionDO {
  constructor(state) { this.state = state }
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/session/${ROOT}/events") {
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode("event: first\\ndata: 1\\n\\n"))
          await new Promise((resolve) => setTimeout(resolve, 50))
          controller.enqueue(encoder.encode("event: second\\ndata: 2\\n\\n"))
          controller.close()
        },
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    }
    return Response.json({
      object: this.state.id.name ?? null,
      method: request.method,
      path: url.pathname,
      search: url.search,
      authorization: request.headers.get("authorization"),
      cookie: request.headers.get("cookie"),
      body: await request.text(),
    })
  }
}
export default { fetch() { return new Response("not found", { status: 404 }) } }
`

/**
 * Bun's `ws` shim cannot drive miniflare's WebSocket client (see
 * relay-workerd-binary.test.ts), so the upgrade is sent from inside workerd
 * and its answer comes back over plain HTTP.
 */
const UPGRADE_PROBE_SCRIPT = `
export default {
  async fetch(request, env) {
    const headers = new Headers(request.headers)
    headers.set("upgrade", "websocket")
    headers.set("connection", "Upgrade")
    const answer = await env.RELAY.fetch(request.url, { headers })
    return new Response(answer.status === 101 ? "upgraded" : await answer.text(), { status: answer.status === 101 ? 500 : answer.status })
  },
}
`

let workDir: string
let mf: Miniflare
let signRat: (input: { sessionId?: string }) => Promise<string>
let relayHostPublicKey: CryptoKey
const resolved: string[] = []

function resolver(request: Request): Response {
  const url = new URL(request.url)
  resolved.push(url.pathname)
  if (request.headers.get("authorization") !== "Bearer resolver-token") return new Response("unauthorized", { status: 401 })
  if (url.pathname === "/internal/relay/target") {
    return Response.json({ workspaceId: url.searchParams.get("workspaceId"), hostId: url.searchParams.get("hostId"), baseUrl: "", backing: "durable-object" })
  }
  if (url.pathname === "/internal/relay/revocation") return Response.json({ active: true })
  return new Response("not found", { status: 404 })
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "relay-session-host-"))
  const outfile = join(workDir, "relay.mjs")
  execFileSync(process.execPath, [
    fileURLToPath(import.meta.resolve("esbuild/bin/esbuild")),
    fileURLToPath(new URL("./worker.ts", import.meta.url)),
    "--bundle",
    "--format=esm",
    "--platform=neutral",
    "--target=es2022",
    "--conditions=development,workerd,worker,browser",
    "--main-fields=module,main",
    `--outfile=${outfile}`,
  ], { stdio: "pipe" })
  const runtimeAccess = await generateKeyPair("EdDSA", { extractable: true })
  const relayHost = await generateKeyPair("EdDSA", { extractable: true })
  relayHostPublicKey = relayHost.publicKey
  signRat = (input) => mintRuntimeAccessToken({
    principalKind: "user",
    actorId: "actor_owner",
    actorKind: "human",
    orgId: "org_1",
    workspaceId: WORKSPACE_ID,
    hostId: HOST_ID,
    role: "editor",
    ...input,
  }, runtimeAccess.privateKey, "EdDSA")
  mf = await bootWorkerd({
    workers: [
      {
        name: "relay",
        modules: true,
        script: await readFile(outfile, "utf8"),
        compatibilityDate: COMPATIBILITY_DATE,
        durableObjects: {
          WORKSPACE_RELAY_ROOM: { className: "WorkspaceRelayRoom", useSQLite: true },
          SESSION_HOST: { className: "SessionDO", scriptName: "session-host", useSQLite: true },
        },
        bindings: {
          CLAXEDO_RELAY_RESOLVER_URL: "https://control-plane.test/internal/relay",
          CLAXEDO_RELAY_RESOLVER_TOKEN: "resolver-token",
          CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(runtimeAccess.publicKey),
          CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM: await exportPKCS8(relayHost.privateKey),
        },
        outboundService: resolver,
      },
      {
        name: "upgrade-probe",
        modules: true,
        script: UPGRADE_PROBE_SCRIPT,
        compatibilityDate: COMPATIBILITY_DATE,
        serviceBindings: { RELAY: "relay" },
      },
      {
        name: "session-host",
        modules: true,
        script: SESSION_HOST_SCRIPT,
        compatibilityDate: COMPATIBILITY_DATE,
        durableObjects: { SESSION_HOST: { className: "SessionDO", useSQLite: true } },
      },
    ],
  })
}, 120_000)

afterAll(async () => {
  reapWorkerd()
  await rm(workDir, { recursive: true, force: true })
})

const relayUrl = (path: string) => `https://relay.test/workspaces/${WORKSPACE_ID}${path}`

describe("relay durable-object target on workerd", () => {
  test("forwards HTTP to the session's object with a relay host token and without cookies", async () => {
    const response = await mf.dispatchFetch(relayUrl("/session?harness=pi"), {
      method: "POST",
      headers: { authorization: `Bearer ${await signRat({})}`, cookie: "session=secret", "content-type": "application/json" },
      body: JSON.stringify({ id: ROOT }),
    })
    expect(response.status).toBe(200)
    const seen = await response.json() as Record<string, string | null>
    expect(seen).toMatchObject({ object: ROOT, method: "POST", path: "/session", search: "?harness=pi", cookie: null, body: JSON.stringify({ id: ROOT }) })
    const claims = await verifyRelayHostToken(seen.authorization!.replace(/^Bearer /, ""), relayHostPublicKey, { workspaceId: WORKSPACE_ID, hostId: HOST_ID })
    expect(claims.backing).toBe("durable-object")
    expect(claims.host_id).toBe(HOST_ID)
    expect(resolved).toContain("/internal/relay/target")
  })

  test("streams the session's event stream through", async () => {
    const response = await mf.dispatchFetch(relayUrl(`/session/${ROOT}/events`), {
      headers: { authorization: `Bearer ${await signRat({ sessionId: ROOT })}` },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    const reader = response.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain("event: first")
    expect(first).not.toContain("event: second")
    let rest = ""
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest += new TextDecoder().decode(chunk.value)
    expect(rest).toContain("event: second")
  })

  test("refuses a WebSocket upgrade to a session host", async () => {
    const probe = await mf.getWorker("upgrade-probe")
    const response = await probe.fetch(relayUrl(`/session/${ROOT}/socket`), {
      headers: { authorization: `Bearer ${await signRat({ sessionId: ROOT })}` },
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "durable_object_websocket_unsupported" } })
  })
})
