/**
 * OpenCode engine transport seam for claxedo-server.
 *
 * Every LOCAL consumer of the old `http://127.0.0.1:4096` opencode-serve URL now
 * rides one injected transport — `opencodeRequest` — instead of building a URL
 * and calling `fetch`. The transport resolves per the mode configured ONCE at a
 * composition root (startControlPlaneStack / startServer / main):
 *
 *   - "embedded" (DEFAULT when no external URL is configured): lazily boots the
 *     OpenCode engine through SDK-next. Desktop supplies an on-demand worker
 *     path so an idle engine can exit; its random loopback port requires a
 *     per-boot capability on every request. Other hosts use the socketless
 *     in-process handler. Nothing listens on the historical fixed :4096 port.
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
import { randomBytes } from "node:crypto"
import { fork, type ChildProcess } from "node:child_process"
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
  if (factory) void engineWorkerPromise?.then((worker) => worker.child.kill()).catch(() => {})
  // An application tool is an in-process registration and cannot cross a fork,
  // so registering one downgrades a configured worker transport to in-process.
  // That is deliberate, but it silently relocates the ENTIRE engine into the
  // always-on server process and removes its ability to exit when idle, which
  // on desktop is a large resident cost with no error and no failing test.
  // Say so once, loudly, at the moment the downgrade is actually created.
  if (factory && workerPath) {
    console.error(
      "[opencode-engine] WARN  application tools registered while an engine worker path is configured;" +
        " the engine will run IN-PROCESS and will not idle-exit. See opencodeEngineTransport().",
    )
  }
  applicationTools = factory
}

// --- Embedded engine (lazy, memoized) ------------------------------------

// Absolute artifact path configured by a composition root (desktop main). The
// bundled claxedo-server cannot rely on bare-specifier resolution — the bundle
// lives outside any node_modules tree that contains "opencode" — so the
// composition root hands us the artifact location explicitly. Undefined keeps
// the historical bare import (claxedo-server dev/tests, external embedders).
let embedPath: string | undefined
let workerPath: string | undefined

export function configureOpenCodeEmbedPath(next: string | undefined) {
  embedPath = next?.trim() || undefined
}

export function configureOpenCodeWorkerPath(next: string | undefined) {
  workerPath = next?.trim() || undefined
}

function defaultLoader(): Promise<EmbeddedModule> {
  if (embedPath) return import(pathToFileURL(embedPath).href)
  return import("opencode/node-embed")
}

// Injectable import seam so tests can exercise the structured-failure path
// without shipping a broken artifact. Production loads the real node artifact.
let loader: () => Promise<EmbeddedModule> = defaultLoader
let forkWorker: typeof fork = fork

/** TEST-ONLY: replace the engine module loader (structured-failure coverage). */
export function __setOpenCodeEmbedLoaderForTests(next: (() => Promise<EmbeddedModule>) | undefined) {
  loader = next ?? defaultLoader
  embeddedHostPromise = undefined
  loadedHost = undefined
}

/** TEST-ONLY: replace the process fork seam for worker transport coverage. */
export function __setOpenCodeWorkerForkForTests(next: typeof fork | undefined) {
  forkWorker = next ?? fork
}

let embeddedHostPromise: Promise<EmbeddedHost> | undefined
let loadedHost: EmbeddedHost | undefined
type EngineWorker = { child: ChildProcess; url: string; authorization: string }

let engineWorkerPromise: Promise<EngineWorker> | undefined
let loggedFailure = false

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
 * Which transport `opencodeRequest` will use, given the configuration so far.
 *
 * Exported because the choice between "worker" and "in-process" is otherwise an
 * invisible consequence of two unrelated composition-root calls, and getting it
 * wrong is expensive but silent: the desktop wires `opencodeWorkerPath` so the
 * engine runs in a forked child that can exit when idle, and registering ANY
 * application tool anywhere in that composition moves the whole engine back
 * into the server process with no error and no failing test.
 *
 * The fallback itself is correct and deliberate — an application tool is an
 * in-process JS registration, so it cannot cross a fork, and
 * `configureOpenCodeApplicationTools` already kills a running worker. What was
 * missing is that the decision was not observable. Naming it makes it
 * assertable; `engine.test.ts` pins the matrix.
 */
export type OpenCodeEngineTransport = "external-url" | "worker" | "in-process"

export function opencodeEngineTransport(): OpenCodeEngineTransport {
  if (config.mode === "external-url") return "external-url"
  if (workerPath && !applicationTools) return "worker"
  return "in-process"
}

/**
 * The stable, importable transport. Every local opencode consumer routes through
 * this. Resolves lazily per the configured mode.
 */
export const opencodeRequest: OpenCodeRequestFn = async (request) => {
  // Single source of truth: routing here and `opencodeEngineTransport()` cannot
  // drift, so a test asserting the latter constrains the former.
  switch (opencodeEngineTransport()) {
    case "external-url":
      return fetch(rewriteToConfiguredUrl(request, (config as Extract<EngineConfig, { mode: "external-url" }>).url))
    case "worker":
      return workerRequest(request)
    case "in-process":
      return (await embeddedHost()).fetch(request)
  }
}

async function workerRequest(request: Request) {
  const worker = await engineWorker()
  const outgoing = rewriteToConfiguredUrl(request, worker.url)
  outgoing.headers.set("authorization", worker.authorization)
  // Never replay a failed request. A transport failure does not prove that the
  // engine did not already perform the requested action, so retrying here can
  // duplicate messages, file writes, or commands. The child's exit handler
  // clears the cached worker; a later caller may start a fresh one.
  return fetch(outgoing)
}

async function engineWorker() {
  if (engineWorkerPromise) return engineWorkerPromise
  const token = randomBytes(32).toString("base64url")
  const pending = new Promise<EngineWorker>((resolve, reject) => {
    const dbDir = path.join(dataDir(), "opencode-engine")
    fs.mkdirSync(dbDir, { recursive: true })
    const child = forkWorker(workerPath!, [], {
      execPath: process.execPath,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        CLAXEDO_ENGINE_EMBED_PATH: embedPath,
        CLAXEDO_ENGINE_DB_PATH: path.join(dbDir, "opencode.db"),
        CLAXEDO_ENGINE_PARENT_PID: String(process.pid),
        CLAXEDO_ENGINE_AUTH_TOKEN: token,
      },
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    })
    let settled = false
    const fail = (cause: unknown) => {
      if (settled) return
      settled = true
      child.kill()
      clearTimeout(timeout)
      reject(new OpenCodeEngineUnavailableError(cause))
      queueMicrotask(() => {
        if (engineWorkerPromise === pending) engineWorkerPromise = undefined
      })
    }
    const timeout = setTimeout(() => fail("Engine worker did not become ready"), 10_000)
    child.once("error", fail)
    child.on("message", (message) => {
      if (settled || !isWorkerReady(message)) return
      settled = true
      clearTimeout(timeout)
      resolve({ child, url: `http://127.0.0.1:${message.port}`, authorization: `Bearer ${token}` })
    })
    child.once("exit", () => {
      clearTimeout(timeout)
      if (!settled) fail("Engine worker exited before becoming ready")
      if (engineWorkerPromise === pending) engineWorkerPromise = undefined
    })
  })
  engineWorkerPromise = pending
  return engineWorkerPromise
}

function isWorkerReady(input: unknown): input is { type: "claxedo-engine-ready"; port: number } {
  if (!input || typeof input !== "object") return false
  const value = input as { type?: unknown; port?: unknown }
  return value.type === "claxedo-engine-ready" && Number.isInteger(value.port) && Number(value.port) > 0
}

/**
 * Drain the embedded engine on shutdown. No-op in URL mode or if the engine was
 * never loaded (nothing to dispose). Wired into shutdownControlPlaneRuntime.
 */
export async function drainOpenCodeEngine(): Promise<void> {
  const worker = await engineWorkerPromise?.catch(() => undefined)
  engineWorkerPromise = undefined
  worker?.child.kill()
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
