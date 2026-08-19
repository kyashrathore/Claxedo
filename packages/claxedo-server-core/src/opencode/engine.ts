/**
 * OpenCode engine transport seam for claxedo-server.
 *
 * Every LOCAL consumer of the old `http://127.0.0.1:4096` opencode-serve URL now
 * rides one injected transport — `opencodeRequest` — instead of building a URL
 * and calling `fetch`. The transport resolves per the mode configured ONCE at a
 * composition root (startControlPlaneStack / startServer / main):
 *
 *   - "embedded" (DEFAULT when no external URL is configured): lazily boots the
 *     OpenCode engine in-process through the SDK-next embedded host and serves
 *     requests socketlessly through its single request handler. NOTHING listens
 *     on :4096.
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
import { pathToFileURL } from "url"
import type { OpenCodeRequestFn } from "@claxedo/agent-sdk-runtime/adapters"
import {
  createEmbeddedHost,
  type ApplicationToolRegistration,
  type EmbeddedHost,
  type EmbeddedModule,
} from "@opencode-ai/sdk-next/embedded"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { opencodeHeaders } from "./auth"

// Re-export so host modules that must NOT depend on @claxedo/agent-sdk-runtime
// directly (architecture guard: embedded-workspace-runtime.ts) can still name
// the transport type via this host-owned engine module.
export type { OpenCodeRequestFn } from "@claxedo/agent-sdk-runtime/adapters"

/** Synthetic origin every local opencode Request is built against. Handlers route on path only. */
export const OPENCODE_INTERNAL_BASE = "http://opencode.internal"

export type OpenCodeEngineMode = "embedded" | "external-url"

type EngineConfig = { mode: "external-url"; url: string; headers?: HeadersInit } | { mode: "embedded" }

// Composition-root state. Defaults to embedded so a fresh `bun run dev` with no
// external engine and no config serves sessions in-process. Only a
// composition root ever writes this.
let config: EngineConfig = { mode: "embedded" }
let applicationTools: (() => Promise<Readonly<Record<string, OpenCodeApplicationToolRegistration>>>) | undefined

/**
 * Structured, actionable failure surfaced to consumers when the embedded engine
 * artifact cannot be loaded (e.g. absent on a fresh checkout). Consumers turn
 * this into a clear HTTP error instead of a bare 500.
 */
export class OpenCodeEngineUnavailableError extends Error {
  readonly code = "opencode_engine_unavailable"
  constructor(cause: unknown) {
    super(
      "The SDK-next embedded OpenCode engine failed to load. Reinstall or rebuild Claxedo so its embedded engine artifact is included. Original error: " +
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

export type OpenCodeApplicationToolRegistration = ApplicationToolRegistration

export function configureOpenCodeApplicationTools(
  factory: (() => Promise<Readonly<Record<string, OpenCodeApplicationToolRegistration>>>) | undefined,
) {
  if (loadedHost && factory)
    throw new Error("OpenCode application tools must be configured before the embedded engine starts")
  applicationTools = factory
}

// --- Embedded engine (lazy, memoized) ------------------------------------

// Absolute artifact path configured by a composition root (desktop main). The
// bundled claxedo-server cannot rely on bare-specifier resolution — the bundle
// lives outside any node_modules tree that contains "opencode" — so the
// composition root hands us the artifact location explicitly. Undefined keeps
// the historical bare import (claxedo-server dev/tests, external embedders).
let embedPath: string | undefined

export function configureOpenCodeEmbedPath(next: string | undefined) {
  embedPath = next?.trim() || undefined
}

function defaultLoader(): Promise<EmbeddedModule> {
  if (embedPath) return import(pathToFileURL(embedPath).href)
  return import("opencode/node-embed")
}

// Injectable import seam so tests can exercise the structured-failure path
// without shipping a broken artifact. Production loads the real node artifact.
let loader: () => Promise<EmbeddedModule> = defaultLoader

/** TEST-ONLY: replace the engine module loader (structured-failure coverage). */
export function __setOpenCodeEmbedLoaderForTests(next: (() => Promise<EmbeddedModule>) | undefined) {
  loader = next ?? defaultLoader
  embeddedHostPromise = undefined
  loadedHost = undefined
}

let embeddedHostPromise: Promise<EmbeddedHost> | undefined
let loadedHost: EmbeddedHost | undefined
let loggedFailure = false

// --- Boot observation -------------------------------------------------------

const bootHooks = new Set<() => void>()

/**
 * True when an engine can serve requests without paying a boot: the embedded
 * host is loaded, or an external engine URL is configured (a remote engine is
 * running by definition). Consumers that must never CAUSE an engine boot —
 * e.g. the credential auth bridge — gate on this instead of calling
 * `opencodeRequest` unconditionally.
 */
export function opencodeEngineLoaded(): boolean {
  return config.mode === "external-url" || loadedHost !== undefined
}

/**
 * Registers a hook fired after every successful embedded-engine boot,
 * including a re-boot after `drainOpenCodeEngine`. Hook errors are isolated
 * from the boot and from each other. Returns the unsubscribe.
 */
export function onOpenCodeEngineBoot(hook: () => void): () => void {
  bootHooks.add(hook)
  return () => {
    bootHooks.delete(hook)
  }
}

function fireBootHooks(): void {
  for (const hook of [...bootHooks]) {
    try {
      hook()
    } catch (err) {
      console.error("[opencode-engine] WARN  boot hook failed:", err)
    }
  }
}

async function embeddedHost(): Promise<EmbeddedHost> {
  embeddedHostPromise ??= (async () => {
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
      const host = await createEmbeddedHost({
        load: loader,
        ...(applicationTools ? { applicationTools } : {}),
      })
      loadedHost = host
      fireBootHooks()
      return host
    } catch (cause) {
      if (!loggedFailure) {
        loggedFailure = true
        console.error("[opencode-engine]", new OpenCodeEngineUnavailableError(cause).message)
      }
      // Reset so a later request (after the artifact is built) can retry.
      embeddedHostPromise = undefined
      loadedHost = undefined
      throw new OpenCodeEngineUnavailableError(cause)
    }
  })()
  return embeddedHostPromise
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
  return (await embeddedHost()).fetch(request)
}

/**
 * Drain the embedded engine on shutdown. No-op in URL mode or if the engine was
 * never loaded (nothing to dispose). Wired into shutdownControlPlaneRuntime.
 */
export async function drainOpenCodeEngine(): Promise<void> {
  if (!loadedHost) return
  const host = loadedHost
  loadedHost = undefined
  embeddedHostPromise = undefined
  try {
    await host.dispose()
  } catch (err) {
    console.error("[opencode-engine] WARN  drain failed:", err)
  }
}
