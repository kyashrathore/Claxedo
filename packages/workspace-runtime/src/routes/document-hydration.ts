import { constants, type FSWatcher } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { inside } from "@claxedo/helpers/path"
import { watchRealDirectory } from "@claxedo/helpers/real-path"
import { createHash } from "node:crypto"
import { verifyDocumentJobCapability } from "../document-job-capability"
import { Hono } from "hono"
import { z } from "zod"
import { asNumber, asRecord, asString } from "@claxedo/helpers/guards"
import {
  boundedJson,
  RequestBodyTooLargeError,
  sessionAccessContext,
  type SessionAccessPolicy,
} from "@claxedo/session-core"
import { authorizeHostCapability } from "./host-capability-access"
import type { RelayHostAuthContext } from "@claxedo/session-core/relay-host"
import { isMissingFile } from "@claxedo/helpers/fs"
import { MAX_DOCUMENT_BYTES, readContained, secureDirectory, writeContained } from "./document-hydration-files"

const Job = z
  .object({
    token: z.string().min(1),
    userId: z.string().min(1),
    orgId: z.string().min(1),
    projectId: z.string().min(1),
  })
  .strict()

/** The on-disk document manifest: this module writes it and reads it back. */
const Manifest = z.object({
  version: z.literal(1),
  documents: z.array(z.record(z.string(), z.unknown())).default([]),
})

/** One manifest entry, as `recoverPersisted` requires it. */
const ManifestEntry = z.object({
  documentId: z.string(),
  path: z.string(),
  baseVersion: z.string(),
  lastSyncedHash: z.string(),
  state: z.enum(["pending", "active", "conflicted"]),
})

/** The control-plane write-back capability, as both routes accept it. */
const Writeback = z
  .object({
    url: z.string().url(),
    renewUrl: z.string().url(),
    token: z.string().min(1),
    expiresAt: z.number().int().positive(),
  })
  .strict()

/** A conflict resolution body: which side wins, plus refreshed capabilities. */
const Resolution = z
  .object({
    strategy: z.string().optional(),
    remoteMarkdown: z.string().optional(),
    remoteVersion: z.string().optional(),
    job: Job.optional(),
    writeback: Writeback.optional(),
  })
  .passthrough()

const Input = z
  .object({
    sessionId: z.string().regex(/^[A-Za-z0-9_-]+$/),
    documentId: z.string().regex(/^[A-Za-z0-9_-]+$/),
    displayName: z.string().min(1),
    markdown: z.string().refine((value) => new TextEncoder().encode(value).byteLength <= 2 * 1024 * 1024),
    baseVersion: z.string().min(1),
    writeback: Writeback,
    job: Job,
  })
  .strict()

const Activation = z.object({}).strict()

type RuntimeDocument = {
  key: string
  root: string
  path: string
  baseVersion: string
  lastMarkdown: string
  writeback: { url: string; renewUrl: string; token: string; expiresAt: number }
  job: z.infer<typeof Job>
  watcher?: FSWatcher
  state: "pending" | "active" | "conflicted"
  tail: Promise<void>
  timer?: ReturnType<typeof setTimeout>
  renewal?: ReturnType<typeof setTimeout>
  renewalTimer: {
    set: typeof setTimeout
    clear: typeof clearTimeout
    now: () => number
  }
  requestTimeoutMs: number
  beforeReadOpen?: () => void | Promise<void>
}

const documents = new Map<string, RuntimeDocument>()
const manifestTails = new Map<string, Promise<void>>()
const sessionLifecycles = new Map<string, Promise<void>>()
const documentLifecycles = new Map<string, Promise<void>>()
const MAX_CALLBACK_RESPONSE_BYTES = 64 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export function RuntimeDocumentHydrationRoutes(
  options: {
    workspaceRoot?: string
    /** The relay-exposed workspace this runtime serves; without it the routes are not served. */
    workspaceId?: string
    controlPlaneOrigin?: string
    verifyJob?: (token: string, expected: Parameters<typeof verifyDocumentJobCapability>[1]) => Promise<unknown>
    beforeReadOpen?: () => void | Promise<void>
    beforeWriteOpen?: () => void | Promise<void>
    afterWatcherCreated?: (watcher: FSWatcher) => void
    renewalTimer?: RuntimeDocument["renewalTimer"]
    requestTimeoutMs?: number
    sessionAccessPolicy?: SessionAccessPolicy
  } = {},
) {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const { workspaceId } = options
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("Runtime document request timeout must be positive")
  }
  return new Hono<{ Variables: RelayHostAuthContext }>()
    .onError((error, context) => {
      if (error instanceof RuntimeDocumentDenied) return context.json({ error: "document_not_found" }, 404)
      if (error instanceof RequestBodyTooLargeError) return context.json({ error: "request_body_too_large" }, 413)
      if (error instanceof SyntaxError || error instanceof z.ZodError) {
        return context.json({ error: "document_request_invalid" }, 400)
      }
      throw error
    })
    .post("/api/wr/documents/hydrate", async (context) => {
      if (!workspaceId) return context.notFound()
      const input = Input.parse(await boundedJson(context.req.raw, MAX_DOCUMENT_BYTES))
      return await withSessionLifecycle(input.sessionId, async () => {
        const authorized = await (options.verifyJob ?? verifyDocumentJobCapability)(input.job.token, {
          userId: input.job.userId,
          orgId: input.job.orgId,
          projectId: input.job.projectId,
          workspaceId,
          sessionId: input.sessionId,
          documentId: input.documentId,
          operation: "hydrate",
        }).then(
          () => true,
          () => false,
        )
        if (!authorized) return context.json({ error: "document_hydration_capability_invalid" }, 403)
        const controlPlaneOrigin = new URL(
          options.controlPlaneOrigin ?? process.env.CLAXEDO_CONTROL_PLANE_URL ?? "invalid:",
        ).origin
        if (
          new URL(input.writeback.url).origin !== controlPlaneOrigin ||
          new URL(input.writeback.renewUrl).origin !== controlPlaneOrigin
        ) {
          return context.json({ error: "document_writeback_origin_invalid" }, 403)
        }
        await authorizeRuntimeDocument(
          controlPlaneOrigin,
          workspaceId,
          input.job,
          input.sessionId,
          input.documentId,
          "hydrate",
          requestTimeoutMs,
        )
        const key = `${input.sessionId}:${input.documentId}`
        return await withDocumentLifecycle(key, async () => {
          const root = await fs.realpath(
            options.workspaceRoot ?? process.env.WORKSPACE_RUNTIME_DIRECTORY ?? "/workspace",
          )
          const claxedo = path.join(root, ".claxedo")
          await fs.mkdir(claxedo, { recursive: true, mode: 0o700 })
          if (!inside(root, await fs.realpath(claxedo))) throw new Error("Runtime document root escapes workspace")
          const directory = await secureDirectory(root, claxedo, [
            "sessions",
            input.sessionId,
            "docs",
            input.documentId,
          ])
          const target = path.join(directory, `${slug(input.displayName)}.md`)
          const manifestPath = path.join(path.dirname(directory), "manifest.json")
          const recovered = await recoverPersisted(manifestPath, input.documentId)
          if (recovered?.state === "conflicted") return context.json({ error: "document_conflicted" }, 409)
          const persistedMarkdown =
            recovered?.path &&
            (await fs.access(recovered.path).then(
              () => true,
              () => false,
            ))
              ? await readContained(root, recovered.path)
              : undefined
          const dirty =
            recovered && persistedMarkdown !== undefined && hash(persistedMarkdown) !== recovered.lastSyncedHash
              ? { markdown: persistedMarkdown, baseVersion: recovered.baseVersion }
              : undefined
          const markdown = dirty?.markdown ?? input.markdown
          await writeContained(root, target, markdown, options.beforeWriteOpen)
          const document: RuntimeDocument = {
            key,
            path: target,
            root,
            baseVersion: dirty?.baseVersion ?? input.baseVersion,
            lastMarkdown: input.markdown,
            writeback: input.writeback,
            job: input.job,
            state: "pending",
            tail: Promise.resolve(),
            renewalTimer: options.renewalTimer ?? { set: setTimeout, clear: clearTimeout, now: Date.now },
            requestTimeoutMs,
            ...(options.beforeReadOpen ? { beforeReadOpen: options.beforeReadOpen } : {}),
          }
          const previous = documents.get(key)
          close(previous)
          documents.set(key, document)
          await persist(input.sessionId, input.documentId, document)
          return context.json({ path: target })
        })
      })
    })
    .post("/api/wr/documents/:sessionId/:documentId/activate", async (context) => {
      if (!workspaceId) return context.notFound()
      const sessionId = context.req.param("sessionId")
      const documentId = context.req.param("documentId")
      if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || !/^[A-Za-z0-9_-]+$/.test(documentId)) {
        return context.json({ error: "document_request_invalid" }, 400)
      }
      const denied = await authorizeHostCapability(
        context,
        options,
        "document_write",
        sessionAccessContext(context),
        sessionId,
      )
      if (denied) return denied
      Activation.parse(await boundedJson(context.req.raw, MAX_DOCUMENT_BYTES))
      return await withDocumentLifecycle(`${sessionId}:${documentId}`, async () => {
        const document = documents.get(`${sessionId}:${documentId}`)
        if (!document) return context.json({ error: "document_hydration_not_found" }, 404)
        const authorized = await (options.verifyJob ?? verifyDocumentJobCapability)(document.job.token, {
          userId: document.job.userId,
          orgId: document.job.orgId,
          projectId: document.job.projectId,
          workspaceId,
          sessionId,
          documentId,
          operation: "write",
        }).then(
          () => true,
          () => false,
        )
        if (!authorized) return context.json({ error: "document_activation_capability_invalid" }, 403)
        await authorizeRuntimeDocument(
          new URL(document.writeback.url).origin,
          workspaceId,
          document.job,
          sessionId,
          documentId,
          "write",
          requestTimeoutMs,
        )
        if (document.state === "conflicted") return context.json({ error: "document_conflicted" }, 409)
        if (document.state === "active") return context.json({ path: document.path })
        installWatcher(document, options.afterWatcherCreated)
        await enqueue(document, () => syncAuthorized(document)).catch((error) => {
          document.watcher?.close()
          document.watcher = undefined
          throw error
        })
        document.state = "active"
        await persistFromPath(document)
        scheduleRenewal(document)
        return context.json({ path: document.path })
      })
    })
    .post("/api/wr/documents/:sessionId/:documentId/resolve", async (context) => {
      if (!workspaceId) return context.notFound()
      const sessionId = context.req.param("sessionId")
      const documentId = context.req.param("documentId")
      const denied = await authorizeHostCapability(
        context,
        options,
        "document_write",
        sessionAccessContext(context),
        sessionId,
      )
      if (denied) return denied
      const parsedBody = Resolution.safeParse(await boundedJson(context.req.raw, MAX_DOCUMENT_BYTES))
      const body = parsedBody.success ? parsedBody.data : undefined
      const key = `${sessionId}:${documentId}`
      return await withDocumentLifecycle(key, async () => {
        const document = documents.get(key)
        if (!document || document.state !== "conflicted")
          return context.json({ error: "document_conflict_not_found" }, 404)
        const job = body?.job
        if (!job) return context.json({ error: "document_capability_required" }, 401)
        const authorized = await (options.verifyJob ?? verifyDocumentJobCapability)(job.token, {
          userId: job.userId,
          orgId: job.orgId,
          projectId: job.projectId,
          workspaceId,
          sessionId,
          documentId,
          operation: "resolve",
        }).then(
          () => true,
          () => false,
        )
        if (!authorized) return context.json({ error: "document_resolution_capability_invalid" }, 403)
        await authorizeRuntimeDocument(
          new URL(document.writeback.url).origin,
          workspaceId,
          job,
          sessionId,
          documentId,
          "resolve",
          requestTimeoutMs,
        )
        const writeback = body.writeback
        if (
          !writeback ||
          writeback.url !== document.writeback.url ||
          writeback.renewUrl !== document.writeback.renewUrl ||
          writeback.expiresAt <= Date.now()
        ) {
          return context.json({ error: "document_writeback_refresh_invalid" }, 400)
        }
        const remoteVersion = body.remoteVersion
        if (remoteVersion === undefined) return context.json({ error: "remote_version_required" }, 400)
        if (body.strategy === "use-remote" && body.remoteMarkdown !== undefined) {
          const preserved = `${document.path}.conflict-${Date.now()}.md`
          await writeContained(document.root, preserved, await readContained(document.root, document.path))
          await writeContained(document.root, document.path, body.remoteMarkdown)
          document.baseVersion = remoteVersion
          document.lastMarkdown = body.remoteMarkdown
          document.writeback = writeback
          document.tail = Promise.resolve()
          document.state = "active"
          scheduleRenewal(document)
          await persistFromPath(document)
          return context.json({ path: document.path, preserved })
        }
        if (body.strategy !== "keep-session") return context.json({ error: "resolution_invalid" }, 400)
        document.baseVersion = remoteVersion
        document.writeback = writeback
        document.tail = Promise.resolve()
        document.state = "active"
        scheduleRenewal(document)
        await enqueueSync(document)
        return context.json({ path: document.path })
      })
    })
}

export async function flushRuntimeDocument(sessionId: string, documentId: string) {
  const key = `${sessionId}:${documentId}`
  const current = documents.get(key)
  if (!current) throw new Error("Runtime document is not hydrated")
  if (current.state === "pending") throw new Error("Runtime document is not activated")
  await withDocumentLifecycle(key, async () => {
    const document = documents.get(key)
    if (!document) throw new Error("Runtime document is not hydrated")
    await enqueueSync(document)
  })
}

export async function flushRuntimeSessionDocuments(sessionId: string) {
  await withSessionLifecycle(sessionId, async () => {
    for (const [key, document] of documents) {
      if (key.startsWith(`${sessionId}:`)) await syncRuntimeDocument(document)
    }
  })
}

export async function disposeRuntimeSessionDocuments(sessionId: string) {
  await withSessionLifecycle(sessionId, () => disposeRuntimeSessionDocumentsNow(sessionId))
}

async function disposeRuntimeSessionDocumentsNow(sessionId: string) {
  const failures: unknown[] = []
  for (const [key, document] of Array.from(documents)) {
    if (!key.startsWith(`${sessionId}:`)) continue
    await withDocumentLifecycle(key, async () => {
      if (!isCurrent(document)) return
      try {
        if (document.state !== "pending") await enqueueSync(document)
      } catch (error) {
        failures.push(error)
      }
      try {
        await release(document)
      } catch (error) {
        failures.push(error)
      } finally {
        if (isCurrent(document)) {
          close(document)
          documents.delete(key)
        }
      }
    })
  }
  if (failures.length) throw new AggregateError(failures, `Runtime document disposal failed for ${sessionId}`)
}

export function forgetRuntimeDocuments() {
  for (const document of documents.values()) close(document)
  documents.clear()
}

function scheduleRenewal(document: RuntimeDocument) {
  if (!isCurrent(document) || document.state !== "active") return
  if (document.renewal) document.renewalTimer.clear(document.renewal)
  document.renewal = document.renewalTimer.set(
    () =>
      void withDocumentLifecycle(document.key, async () => {
        if (!isCurrent(document)) return
        try {
          await renew(document)
        } catch (error) {
          if (!isCurrent(document)) return
          document.state = "conflicted"
          await persistFromPath(document)
          console.error("[runtime-document] capability renewal failed:", error)
        }
      }).catch((error) => {
        console.error("[runtime-document] capability renewal failure handling failed:", error)
      }),
    Math.max(1_000, document.writeback.expiresAt - document.renewalTimer.now() - 60_000),
  )
}

class RuntimeDocumentDenied extends Error {}

/** The control plane decides whether the job's person may still edit the page; the runtime only asks. */
async function authorizeRuntimeDocument(
  origin: string,
  workspaceId: string,
  job: z.infer<typeof Job>,
  sessionId: string,
  documentId: string,
  operation: "hydrate" | "write" | "resolve",
  timeoutMs: number,
) {
  const response = await fetchWithTimeout(
    `${origin}/documents/${encodeURIComponent(documentId)}/runtime-authorization`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${job.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        userId: job.userId,
        orgId: job.orgId,
        projectId: job.projectId,
        workspaceId,
        sessionId,
        operation,
      }),
    },
    timeoutMs,
  )
  await response.body?.cancel()
  if (!response.ok) throw new RuntimeDocumentDenied()
}

async function renew(document: RuntimeDocument) {
  if (!isCurrent(document)) return
  const result = await fetchJsonWithTimeout(
    document.writeback.renewUrl,
    {
      method: "POST",
      headers: { authorization: `Bearer ${document.writeback.token}` },
    },
    document.requestTimeoutMs,
  )
  if (!result.response.ok)
    throw new Error(`Runtime document capability renewal failed: ${result.response.status}`)
  const value = asRecord(result.value)
  const token = asString(value?.token)
  const expiresAt = asNumber(value?.expiresAt)
  if (token === undefined || expiresAt === undefined) {
    throw new Error("Runtime document capability renewal response is invalid")
  }
  if (!isCurrent(document)) return
  document.writeback.token = token
  document.writeback.expiresAt = expiresAt
  scheduleRenewal(document)
}

async function release(document: RuntimeDocument) {
  const url = new URL(document.writeback.url)
  url.pathname = url.pathname.replace(/\/runtime-writeback$/, "/runtime-job")
  const response = await fetchWithTimeout(
    url,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${document.writeback.token}` },
    },
    document.requestTimeoutMs,
  )
  if (!response.ok && response.status !== 404)
    throw new Error(`Runtime document job release failed: ${response.status}`)
}

function enqueueSync(document: RuntimeDocument) {
  return enqueue(document, () => sync(document))
}

function enqueue(document: RuntimeDocument, run: () => Promise<void>) {
  document.tail = document.tail.catch(() => undefined).then(run)
  return document.tail
}

async function sync(document: RuntimeDocument) {
  if (document.state === "pending") throw new Error("Runtime document is not activated")
  return await syncAuthorized(document)
}

async function syncAuthorized(document: RuntimeDocument) {
  if (document.state === "conflicted") throw new Error("Runtime document is conflicted")
  const markdown = await readContained(document.root, document.path, document.beforeReadOpen)
  if (markdown === document.lastMarkdown) return
  const result = await fetchJsonWithTimeout(
    document.writeback.url,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${document.writeback.token}`,
        "content-type": "application/json",
        "if-match": document.baseVersion,
      },
      body: JSON.stringify({ markdown }),
    },
    document.requestTimeoutMs,
  )
  if (result.response.status === 409) {
    document.state = "conflicted"
    await persistFromPath(document)
    throw new Error("Runtime document write-back conflicted")
  }
  if (!result.response.ok) throw new Error(`Runtime document write-back failed: ${result.response.status}`)
  const version = asString(asRecord(result.value)?.version)
  if (version === undefined) throw new Error("Runtime document write-back response is invalid")
  document.baseVersion = version
  document.lastMarkdown = markdown
  await persistFromPath(document)
}

async function persistFromPath(document: RuntimeDocument) {
  if (!isCurrent(document)) return
  const parts = document.path.split(path.sep)
  const sessions = parts.lastIndexOf("sessions")
  await persist(parts[sessions + 1], parts[sessions + 3], document)
}

async function persist(sessionId: string, documentId: string, document: RuntimeDocument) {
  if (!isCurrent(document)) return
  const manifestPath = path.join(path.dirname(path.dirname(document.path)), "manifest.json")
  const previous = manifestTails.get(manifestPath) ?? Promise.resolve()
  const run = previous.then(async () => {
    if (!isCurrent(document)) return
    const existing = await fs.readFile(manifestPath, "utf8").then(
      (value) => Manifest.parse(JSON.parse(value)),
      (error: unknown) => {
        if (isMissingFile(error)) return { version: 1 as const, documents: [] }
        throw error
      },
    )
    const entry = {
      documentId,
      path: document.path,
      baseVersion: document.baseVersion,
      lastSyncedHash: hash(document.lastMarkdown),
      state: document.state,
    }
    const body = JSON.stringify({
      version: 1,
      documents: [...existing.documents.filter((candidate) => candidate.documentId !== documentId), entry],
    })
    const temp = `${manifestPath}.${crypto.randomUUID()}.tmp`
    const handle = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    await handle.writeFile(body)
    await handle.sync()
    await handle.close()
    await fs.rename(temp, manifestPath)
  })
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  manifestTails.set(manifestPath, tail)
  try {
    await run
  } finally {
    if (manifestTails.get(manifestPath) === tail) manifestTails.delete(manifestPath)
  }
}

function isCurrent(document: RuntimeDocument) {
  return documents.get(document.key) === document
}

async function syncRuntimeDocument(document: RuntimeDocument) {
  await withDocumentLifecycle(document.key, async () => {
    if (!isCurrent(document)) return
    await enqueueSync(document)
  })
}

async function withSessionLifecycle<T>(sessionId: string, mutate: () => Promise<T>) {
  const previous = sessionLifecycles.get(sessionId) ?? Promise.resolve()
  const run = previous.then(mutate)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  sessionLifecycles.set(sessionId, tail)
  try {
    return await run
  } finally {
    if (sessionLifecycles.get(sessionId) === tail) sessionLifecycles.delete(sessionId)
  }
}

async function withDocumentLifecycle<T>(key: string, mutate: () => Promise<T>) {
  const previous = documentLifecycles.get(key) ?? Promise.resolve()
  const run = previous.then(mutate)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  documentLifecycles.set(key, tail)
  try {
    return await run
  } finally {
    if (documentLifecycles.get(key) === tail) documentLifecycles.delete(key)
  }
}

function close(document?: RuntimeDocument) {
  document?.watcher?.close()
  if (document?.timer) clearTimeout(document.timer)
  if (document?.renewal) document.renewalTimer.clear(document.renewal)
}

function installWatcher(document: RuntimeDocument, afterCreated?: (watcher: FSWatcher) => void) {
  if (document.watcher) return
  const watcher = watchRealDirectory(path.dirname(document.path), { persistent: false }, () => {
    if (!isCurrent(document) || document.state !== "active") return
    if (document.timer) clearTimeout(document.timer)
    document.timer = setTimeout(() => {
      void syncRuntimeDocument(document).catch((error) => {
        console.error(`[runtime-document] write-back failed for ${document.key}:`, error)
      })
    }, 100)
  })
  document.watcher = watcher
  watcher.on("error", (error) => {
    void withDocumentLifecycle(document.key, async () => {
      if (!isCurrent(document)) return
      document.state = "conflicted"
      await persistFromPath(document)
      console.error(`[runtime-document] watcher failed for ${document.key}:`, error)
    }).catch(() => undefined)
  })
  try {
    afterCreated?.(watcher)
  } catch (error) {
    watcher.close()
    document.watcher = undefined
    throw error
  }
}

async function fetchWithTimeout(input: string | URL, init: RequestInit, timeoutMs: number) {
  return await withRequestDeadline(timeoutMs, async (signal) => await fetch(input, { ...init, signal }))
}

async function fetchJsonWithTimeout(input: string | URL, init: RequestInit, timeoutMs: number) {
  return await withRequestDeadline(timeoutMs, async (signal) => {
    const response = await fetch(input, { ...init, signal })
    if (!response.ok) return { response, value: undefined }
    return { response, value: await readCallbackJson(response, signal) }
  })
}

async function readCallbackJson(response: Response, signal: AbortSignal) {
  const declared = response.headers.get("content-length")
  if (declared !== null && Number(declared) > MAX_CALLBACK_RESPONSE_BYTES) {
    throw new Error("Runtime document callback response is too large")
  }
  if (!response.body) throw new Error("Runtime document callback response is invalid")
  const reader = response.body.getReader()
  const cancel = () => void reader.cancel(signal.reason).catch(() => undefined)
  signal.addEventListener("abort", cancel, { once: true })
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > MAX_CALLBACK_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error("Runtime document callback response is too large")
      }
      chunks.push(chunk.value)
    }
  } finally {
    signal.removeEventListener("abort", cancel)
  }
  const body = new Uint8Array(total)
  let offset = 0
  chunks.forEach((chunk) => {
    body.set(chunk, offset)
    offset += chunk.byteLength
  })
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown
}

async function withRequestDeadline<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController()
  let rejectDeadline: (error: Error) => void = () => undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject
  })
  const timeout = setTimeout(() => {
    const error = new Error(`Runtime document request timed out after ${timeoutMs}ms`)
    controller.abort(error)
    rejectDeadline(error)
  }, timeoutMs)
  timeout.unref()
  try {
    return await Promise.race([operation(controller.signal), deadline])
  } finally {
    clearTimeout(timeout)
  }
}

function slug(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-|-$/g, "") || "document"
  )
}

async function recoverPersisted(manifestPath: string, documentId: string) {
  const raw = await fs.readFile(manifestPath, "utf8").catch((error: unknown) => {
    if (isMissingFile(error)) return undefined
    throw error
  })
  if (!raw) return undefined
  const manifest = Manifest.safeParse(JSON.parse(raw))
  const found = manifest.success
    ? manifest.data.documents.find((candidate) => candidate.documentId === documentId)
    : undefined
  const entry = ManifestEntry.safeParse(found)
  if (!entry.success) throw new Error("Runtime document manifest is invalid")
  return {
    path: entry.data.path,
    baseVersion: entry.data.baseVersion,
    lastSyncedHash: entry.data.lastSyncedHash,
    state: entry.data.state,
  }
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex")
}
