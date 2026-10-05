import { builtinModules } from "node:module"
import type { Readable } from "node:stream"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { exportSPKI } from "jose"
import { Miniflare } from "miniflare"
import { mintRelayHostToken } from "@claxedo/workspace-relay"
import { sessionHostId } from "@claxedo/workspace-relay-protocol"
import { OWNER, WORKSPACE_ID } from "./control-plane"

const WORKER = fileURLToPath(new URL("../worker.ts", import.meta.url))
const AUTHORITY_URL = "https://control-plane.test/api/runtime-authority/session-authorize"

/** The Worker as wrangler bundles it under `nodejs_compat`: bare Node built-ins are the runtime's `node:` modules. */
export async function bundleSessionHostWorker(): Promise<string> {
  const result = await build({
    entryPoints: [WORKER], bundle: true, format: "esm", platform: "neutral", target: "es2022", write: false,
    conditions: ["development", "workerd", "worker", "browser"], mainFields: ["module", "main"], external: ["cloudflare:*", "node:*"],
    plugins: [{
      name: "node-builtins",
      setup: (bundler) => bundler.onResolve({ filter: new RegExp(`^(${builtinModules.join("|")})(/|$)`) },
        (args) => ({ path: `node:${args.path}`, external: true })),
    }],
  })
  return result.outputFiles[0].text
}

/** One workerd running the session-host Worker, its control plane reached through a Node service binding. */
export async function startSessionHostWorker(input: { script: string; persist: string; relayHostKey: CryptoKey; controlPlane: (request: Request) => Promise<Response> | Response }) {
  const stderr: string[] = []
  const miniflare = new Miniflare({
    compatibilityDate: "2026-07-22",
    compatibilityFlags: ["nodejs_compat"],
    modules: [{ type: "ESModule", path: "worker.mjs", contents: input.script }],
    durableObjects: { SESSION_HOST: { className: "SessionDO", useSQLite: true } },
    durableObjectsPersist: input.persist,
    serviceBindings: { CONTROL_PLANE: async (request: unknown) => await input.controlPlane(request as Request) as never },
    bindings: {
      WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL: AUTHORITY_URL,
      WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM: await exportSPKI(input.relayHostKey),
    },
    handleRuntimeStdio: (stdout: Readable, err: Readable) => {
      stdout.resume()
      err.on("data", (chunk: Buffer) => stderr.push(chunk.toString()))
    },
  })
  await miniflare.ready
  return Object.assign(miniflare, { stderr: () => stderr.join("") })
}

/** A client of one session's object for one person, reaching it as the relay does: a relay host token for its host and the relay's markers. */
export function sessionHostClient(miniflare: Miniflare & { stderr(): string }, input: { root: string; relayHostSigningKey: CryptoKey; user?: string }) {
  const user = input.user ?? OWNER
  const headers = async () => ({
    authorization: `Bearer ${await mintRelayHostToken({
      principalKind: "user", actorId: user, userId: user, actorKind: "human", orgId: "org_1", workspaceId: WORKSPACE_ID,
      hostId: sessionHostId(input.root), role: "editor", sessionId: input.root, backing: "durable-object", parentJti: `rat_${crypto.randomUUID()}`,
    }, input.relayHostSigningKey, "EdDSA")}`,
    "x-workspace-id": WORKSPACE_ID,
    "x-forwarded-by": "workspace-relay",
  })
  const request = async (path: string, init: RequestInit = {}) => {
    const namespace = await miniflare.getDurableObjectNamespace("SESSION_HOST")
    const relayed = new Headers(await headers())
    new Headers(init.headers).forEach((value, name) => relayed.set(name, value))
    return namespace.get(namespace.idFromName(input.root)).fetch(`https://session-host.invalid${path}`, {
      method: init.method ?? "GET", headers: Object.fromEntries(relayed), ...(init.body == null ? {} : { body: init.body as string }), ...(init.signal ? { signal: init.signal } : {}),
    } as never) as unknown as Promise<Response>
  }
  const fetchObject = (path: string, init: { method?: string; body?: unknown; signal?: AbortSignal; headers?: Record<string, string> } = {}) => request(path, {
    method: init.method ?? "GET",
    headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    ...(init.signal ? { signal: init.signal } : {}),
  })
  const json = async <T>(path: string, init?: Parameters<typeof fetchObject>[1]): Promise<T> => {
    const response = await fetchObject(path, init)
    const text = await response.text()
    if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} answered ${response.status}: ${text}\n${miniflare.stderr()}`)
    return (text ? JSON.parse(text) : undefined) as T
  }
  return { fetch: fetchObject, request, json }
}
