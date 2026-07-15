/**
 * OpenCode engine transport seam for claxedo-server.
 *
 * Every LOCAL consumer of the old `http://127.0.0.1:4096` opencode-serve URL now
 * rides one injected transport — `opencodeRequest` — instead of building a URL
 * and calling `fetch`. The transport resolves per the mode configured ONCE at a
 * composition root (startControlPlaneStack / startServer / main):
 *
 *   - "embedded" (DEFAULT when no external URL is configured): lazily boots the
 *     OpenCode engine in-process via its Bun-built node artifact
 *     (`opencode/node-embed`) and serves requests socketlessly through
 *     `Server.Default().app.fetch`. NOTHING listens on :4096.
 *   - "external-url": an explicit opt-in. Rewrites the synthetic request origin
 *     (`http://opencode.internal`) onto the configured URL and calls `fetch`,
 *     applying opencodeHeaders — i.e. the historical passthrough behavior.
 *
 * Requests are built against a synthetic base `http://opencode.internal`; the
 * engine (and the URL-mode rewrite) route on path only. This mirrors the kit's
 * `WorkspaceHostOptions.opencodeRequest` transport (base `http://opencode.internal`).
 */

import path from "path"
import fs from "fs"
import type { OpenCodeRequestFn } from "@claxedo/agent-sdk-runtime/adapters"
import { dataDir } from "./paths"
import { opencodeHeaders } from "./opencode-auth"

// Re-export so host modules that must NOT depend on @claxedo/agent-sdk-runtime
// directly (architecture guard: embedded-workspace-runtime.ts) can still name
// the transport type via this host-owned engine module.
export type { OpenCodeRequestFn } from "@claxedo/agent-sdk-runtime/adapters"

/** Synthetic origin every local opencode Request is built against. Handlers route on path only. */
export const OPENCODE_INTERNAL_BASE = "http://opencode.internal"

export type OpenCodeEngineMode = "embedded" | "external-url"

type EngineConfig = { mode: "external-url"; url: string; headers?: HeadersInit } | { mode: "embedded" }

// Composition-root state. Defaults to embedded so a fresh `bun run dev` with no
// external engine and no config serves sessions in-process (R5). Only a
// composition root ever writes this.
let config: EngineConfig = { mode: "embedded" }
let applicationTools: (() => Promise<Readonly<Record<string, OpenCodeApplicationToolRegistration>>>) | undefined
let disposeApplicationTools: (() => Promise<void>) | undefined

/**
 * Structured, actionable failure surfaced to consumers when the embedded engine
 * artifact cannot be loaded (e.g. absent on a fresh checkout). Consumers turn
 * this into a clear HTTP error instead of a bare 500 (R5).
 */
export class OpenCodeEngineUnavailableError extends Error {
  readonly code = "opencode_engine_unavailable"
  constructor(cause: unknown) {
    super(
      "The embedded OpenCode engine failed to load. Build its node artifact first:\n" +
        "  bun run --cwd packages/opencode build:node\n" +
        "(run from the repo root). Original error: " +
        (cause instanceof Error ? cause.message : String(cause)),
    )
    this.name = "OpenCodeEngineUnavailableError"
    if (cause instanceof Error) this.cause = cause
  }
}

/**
 * Configure the engine transport. Called ONLY from composition roots. Passing
 * no URL (or `{ embedded: true }`) selects embedded mode.
 */
export function configureOpenCodeEngine(input: { url: string; headers?: HeadersInit } | { embedded: true }) {
  if ("embedded" in input) {
    config = { mode: "embedded" }
    return
  }
  config = { mode: "external-url", url: input.url, ...(input.headers ? { headers: input.headers } : {}) }
}

export function opencodeEngineMode(): OpenCodeEngineMode {
  return config.mode
}

export type OpenCodeApplicationToolRegistration = Readonly<{
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  execute(
    input: unknown,
    context: Readonly<{
      sessionID: string
      agent: string
      assistantMessageID: string
      toolCallID: string
    }>,
  ): Promise<unknown>
}>

export function configureOpenCodeApplicationTools(
  factory: (() => Promise<Readonly<Record<string, OpenCodeApplicationToolRegistration>>>) | undefined,
) {
  if (loadedModule && factory)
    throw new Error("OpenCode application tools must be configured before the embedded engine starts")
  applicationTools = factory
}

/**
 * Back-compat: historical local callers/tests configured the opencode-compat
 * transport by URL. That is now an explicit external-URL opt-in on the engine
 * transport. Kept so the compat-route body and its URL-mode tests read the same.
 */
export function configureOpenCodeCompat(url: string) {
  configureOpenCodeEngine({ url })
}

// --- Embedded engine (lazy, memoized) ------------------------------------

type EmbeddedHandler = (request: Request) => Promise<Response> | Response

// Injectable import seam so tests can exercise the structured-failure path
// without shipping a broken artifact. Production loads the real node artifact.
type EmbedModule = typeof import("opencode/node-embed")
let loader: () => Promise<EmbedModule> = () => import("opencode/node-embed")

/** TEST-ONLY: replace the engine module loader (structured-failure coverage). */
export function __setOpenCodeEmbedLoaderForTests(next: (() => Promise<EmbedModule>) | undefined) {
  loader = next ?? (() => import("opencode/node-embed"))
  embeddedHandlerPromise = undefined
  loadedModule = undefined
}

let embeddedHandlerPromise: Promise<EmbeddedHandler> | undefined
let loadedModule: EmbedModule | undefined
let loggedFailure = false

async function embeddedHandler(): Promise<EmbeddedHandler> {
  embeddedHandlerPromise ??= (async () => {
    // The engine reads OPENCODE_DB (its own wire format) at import time via
    // core/src/flag/flag.ts. We MUST set it — an absolute path under Claxedo's
    // data dir — BEFORE importing the module so the engine's process-global
    // sqlite is isolated from any stray external `opencode serve`. This is the
    // one sanctioned ambient-env write outside a composition root (see the
    // opencode-engine.ts exception in the ambient-env architecture guard).
    const dbDir = path.join(dataDir(), "opencode-engine")
    fs.mkdirSync(dbDir, { recursive: true })
    process.env.OPENCODE_DB = path.join(dbDir, "opencode.db")
    try {
      const mod = await loader()
      loadedModule = mod
      if (applicationTools)
        disposeApplicationTools = await mod.ApplicationToolRuntime.register(await applicationTools())
      const handler = mod.Server.Default().app.fetch
      return handler as EmbeddedHandler
    } catch (cause) {
      if (!loggedFailure) {
        loggedFailure = true
        console.error("[opencode-engine]", new OpenCodeEngineUnavailableError(cause).message)
      }
      // Reset so a later request (after the artifact is built) can retry.
      embeddedHandlerPromise = undefined
      loadedModule = undefined
      throw new OpenCodeEngineUnavailableError(cause)
    }
  })()
  return embeddedHandlerPromise
}

// --- URL-mode rewrite -----------------------------------------------------

function rewriteToConfiguredUrl(request: Request, url: string): Request {
  const incoming = new URL(request.url)
  const target = new URL(url)
  // Preserve the base URL path prefix (if the configured URL carries one), then
  // append the incoming path + query. Origin comes from the configured URL.
  const basePath = target.pathname.replace(/\/+$/, "")
  target.pathname = basePath + incoming.pathname
  target.search = incoming.search
  const headers = opencodeHeaders(request.headers)
  headers.delete("host")
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    ...(["GET", "HEAD"].includes(request.method) ? {} : { body: request.body, duplex: "half" }),
  }
  return new Request(target.toString(), init)
}

/**
 * The stable, importable transport. Every local opencode consumer routes through
 * this. Resolves lazily per the configured mode.
 */
export const opencodeRequest: OpenCodeRequestFn = async (request) => {
  if (config.mode === "external-url") {
    return fetch(rewriteToConfiguredUrl(request, config.url))
  }
  const handler = await embeddedHandler()
  return handler(request)
}

/**
 * Drain the embedded engine on shutdown. No-op in URL mode or if the engine was
 * never loaded (nothing to dispose). Wired into shutdownControlPlaneRuntime.
 */
export async function drainOpenCodeEngine(): Promise<void> {
  if (!loadedModule) return
  const module = loadedModule
  const disposeTools = disposeApplicationTools
  loadedModule = undefined
  embeddedHandlerPromise = undefined
  disposeApplicationTools = undefined
  try {
    await disposeTools?.()
    await module.InstanceRuntime.disposeAllInstances()
  } catch (err) {
    console.error("[opencode-engine] WARN  drain failed:", err)
  }
}
