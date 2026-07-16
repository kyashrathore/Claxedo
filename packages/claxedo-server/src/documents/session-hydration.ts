import fs from "node:fs/promises"
import path from "node:path"
import { constants, watch, type FSWatcher } from "node:fs"
import { BoundedFileTooLargeError, readBoundedFile } from "./bounded-file-read"
import { contentHash } from "./version"

type ManifestEntry = {
  documentId: string
  path: string
  baseVersion: string
  lastSyncedHash: string
  state: "active" | "conflicted"
}

type Manifest = { version: 1; documents: ManifestEntry[] }

export type HydratedSessionDisposalFailure = Readonly<{
  documentId: string
  path: string
  error: unknown
}>

type HydratedDocument = ManifestEntry & {
  sessionId: string
  root: string
  manifestPath: string
  syncContent: (markdown: string, expectedVersion: string) => Promise<string>
  sync: () => Promise<void>
  watcher: FSWatcher
  timer?: ReturnType<typeof setTimeout>
  error?: unknown
  beforeReadOpen?: () => void | Promise<void>
}

const sessions = new Map<string, Map<string, HydratedDocument>>()
const manifestMutations = new Map<string, Promise<void>>()
const sessionLifecycles = new Map<string, Promise<void>>()
const documentLifecycles = new Map<string, Promise<void>>()
const MAX_HYDRATED_DOCUMENT_BYTES = 2 * 1024 * 1024

type HydrateSessionDocumentInput = {
  sessionId: string
  workspaceRoot: string
  documentId: string
  displayName: string
  markdown: string
  baseVersion: string
  sync: (markdown: string, expectedVersion: string) => Promise<string>
  faults?: {
    beforeReadOpen?: () => void | Promise<void>
    beforeWriteOpen?: () => void | Promise<void>
    afterWatcherCreated?: (watcher: FSWatcher) => void
  }
}

export async function reachableLocalSessionWorkspace(input: {
  host: "central" | "workspace"
  workspaceId?: string
  directory?: string
  toolSandbox?:
    | { kind: "virtual"; id?: string }
    | { kind: "workspace-runtime"; workspaceId: string; directory?: string }
  resolveWorkspace: (workspaceId: string) => Promise<{ kind: string; directory: string } | undefined>
}) {
  if (input.toolSandbox?.kind === "virtual") return undefined
  if (input.host === "central" && input.toolSandbox?.kind !== "workspace-runtime") return undefined
  const workspaceId =
    input.toolSandbox?.kind === "workspace-runtime" ? input.toolSandbox.workspaceId : input.workspaceId
  const workspace = workspaceId ? await input.resolveWorkspace(workspaceId) : undefined
  if (workspace?.kind === "local") return { workspaceId, root: workspace.directory }
  if (input.host === "workspace" && input.directory) return { workspaceId, root: input.directory }
  return undefined
}

export async function hydrateSessionDocument(input: HydrateSessionDocumentInput) {
  requireSessionId(input.sessionId)
  return await withSessionLifecycle(input.sessionId, () =>
    withDocumentLifecycle(input.sessionId, input.documentId, () => hydrateSessionDocumentNow(input)),
  )
}

async function hydrateSessionDocumentNow(input: HydrateSessionDocumentInput) {
  const root = await fs.realpath(input.workspaceRoot)
  const claxedoRoot = path.join(root, ".claxedo")
  await fs.mkdir(claxedoRoot, { mode: 0o700, recursive: true })
  if (!inside(root, await fs.realpath(claxedoRoot))) throw new Error("Session hydration root escapes the workspace")
  const hydrationRoot = path.join(claxedoRoot, "sessions", safeSegment(input.sessionId))
  await fs.mkdir(hydrationRoot, { mode: 0o700, recursive: true })
  if (!inside(root, await fs.realpath(hydrationRoot))) throw new Error("Session hydration root escapes the workspace")
  const documentsRoot = path.join(hydrationRoot, "docs")
  const manifestPath = path.join(documentsRoot, "manifest.json")
  const previous = sessions.get(input.sessionId)?.get(input.documentId)
  if (previous) await previous.sync()
  close(previous)
  const hydrated = await withManifestMutation(manifestPath, async () => {
    const manifest = await readManifest(manifestPath)
    const existing = manifest.documents.find((document) => document.documentId === input.documentId)
    let markdown = input.markdown
    let baseVersion = input.baseVersion
    if (existing?.state === "conflicted") throw new Error(`Hydrated document ${input.documentId} is conflicted`)
    if (existing && (await exists(existing.path))) {
      const dirty = await readContained(root, existing.path)
      if (hash(dirty) !== existing.lastSyncedHash) {
        try {
          existing.baseVersion = await input.sync(dirty, existing.baseVersion)
        } catch (error) {
          existing.state = "conflicted"
          await writeManifest(manifestPath, manifest)
          throw error
        }
        existing.lastSyncedHash = hash(dirty)
        markdown = dirty
        baseVersion = existing.baseVersion
        await writeManifest(manifestPath, manifest)
      }
    }
    const directory = path.join(documentsRoot, safeSegment(input.documentId))
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    if (!inside(root, await fs.realpath(directory)))
      throw new Error("Hydrated document directory escapes the workspace")
    const target = path.join(directory, `${slug(input.displayName)}.md`)
    if (!existing && (await exists(target))) throw new Error("Untracked hydrated document already exists")
    await writeContained(root, target, markdown, input.faults?.beforeWriteOpen)
    const canonical = await fs.realpath(target)
    if (!inside(root, canonical)) throw new Error("Hydrated document path escapes the workspace")
    const entry: ManifestEntry = {
      documentId: input.documentId,
      path: canonical,
      baseVersion: existing?.baseVersion ?? baseVersion,
      lastSyncedHash: hash(markdown),
      state: "active",
    }
    manifest.documents = [...manifest.documents.filter((document) => document.documentId !== input.documentId), entry]
    await writeManifest(manifestPath, manifest)
    return { canonical, directory, entry }
  })

  const documents = sessions.get(input.sessionId) ?? new Map<string, HydratedDocument>()
  let tail: Promise<void> = Promise.resolve()
  const document: HydratedDocument = {
    ...hydrated.entry,
    sessionId: input.sessionId,
    root,
    manifestPath,
    syncContent: input.sync,
    sync: undefined as unknown as () => Promise<void>,
    watcher: undefined as unknown as FSWatcher,
    ...(input.faults?.beforeReadOpen ? { beforeReadOpen: input.faults.beforeReadOpen } : {}),
  }
  document.sync = () => {
    if (document.state === "conflicted") {
      return Promise.reject(document.error ?? new Error(`Hydrated document ${document.documentId} is conflicted`))
    }
    tail = tail.then(async () => {
      try {
        const markdown = await readContained(document.root, document.path, document.beforeReadOpen)
        if (hash(markdown) === document.lastSyncedHash) return
        document.baseVersion = await document.syncContent(markdown, document.baseVersion)
        document.lastSyncedHash = hash(markdown)
        await persist(document)
      } catch (error) {
        await parkConflict(document, error)
        throw document.error
      }
    })
    return tail
  }
  document.watcher = watch(hydrated.directory, { persistent: false }, () => {
    if (!isCurrent(document)) return
    if (document.timer) clearTimeout(document.timer)
    document.timer = setTimeout(() => {
      void syncHydratedDocument(document).catch((error) => {
        console.error(`[session-hydration] failed to sync ${document.documentId}:`, error)
      })
    }, 100)
  })
  document.watcher.on("error", (error) => {
    void withDocumentLifecycle(document.sessionId, document.documentId, async () => {
      if (!isCurrent(document)) return
      await reportWatcherError(document, error)
    }).catch((reportError) => {
      console.error(`[session-hydration] failed to handle watcher error for ${document.documentId}:`, reportError)
    })
  })
  input.faults?.afterWatcherCreated?.(document.watcher)
  documents.set(input.documentId, document)
  sessions.set(input.sessionId, documents)
  return hydrated.canonical
}

export async function recoverHydratedSessionDocument(input: {
  sessionId: string
  workspaceRoot: string
  documentId: string
  displayName: string
  remoteMarkdown: string
  remoteVersion: string
  resolution: "keep-session" | "use-remote"
  sync: (markdown: string, expectedVersion: string) => Promise<string>
}) {
  requireSessionId(input.sessionId)
  return await withSessionLifecycle(input.sessionId, () =>
    withDocumentLifecycle(input.sessionId, input.documentId, () => recoverHydratedSessionDocumentNow(input)),
  )
}

async function recoverHydratedSessionDocumentNow(input: {
  sessionId: string
  workspaceRoot: string
  documentId: string
  displayName: string
  remoteMarkdown: string
  remoteVersion: string
  resolution: "keep-session" | "use-remote"
  sync: (markdown: string, expectedVersion: string) => Promise<string>
}) {
  forgetHydratedDocumentRuntime(input.sessionId, input.documentId)
  const root = await fs.realpath(input.workspaceRoot)
  const manifestPath = path.join(root, ".claxedo", "sessions", safeSegment(input.sessionId), "docs", "manifest.json")
  await withManifestMutation(manifestPath, async () => {
    const manifest = await readManifest(manifestPath)
    const entry = manifest.documents.find((document) => document.documentId === input.documentId)
    if (!entry || entry.state !== "conflicted")
      throw new Error(`Hydrated document ${input.documentId} is not conflicted`)
    const localMarkdown = await readContained(root, entry.path)
    if (input.resolution === "keep-session") {
      entry.baseVersion = await input.sync(localMarkdown, input.remoteVersion)
      entry.lastSyncedHash = hash(localMarkdown)
    } else {
      const preserved = `${entry.path}.conflict-${Date.now()}.md`
      await writeContained(root, preserved, localMarkdown)
      await writeContained(root, entry.path, input.remoteMarkdown)
      entry.baseVersion = input.remoteVersion
      entry.lastSyncedHash = hash(input.remoteMarkdown)
    }
    entry.state = "active"
    await writeManifest(manifestPath, manifest)
  })
  return await hydrateSessionDocumentNow({
    sessionId: input.sessionId,
    workspaceRoot: root,
    documentId: input.documentId,
    displayName: input.displayName,
    markdown:
      input.resolution === "use-remote"
        ? input.remoteMarkdown
        : await currentHydratedMarkdown(manifestPath, root, input.documentId),
    baseVersion: input.remoteVersion,
    sync: input.sync,
  })
}

export async function syncHydratedSessionDocuments(sessionId: string) {
  await withSessionLifecycle(sessionId, async () => {
    for (const document of sessions.get(sessionId)?.values() ?? []) await syncHydratedDocument(document)
  })
}

export function hydratedSessionDocumentPaths(sessionId: string) {
  return [...(sessions.get(sessionId)?.values() ?? [])].map((document) => document.path)
}

export async function disposeHydratedSessionDocuments(sessionId: string): Promise<HydratedSessionDisposalFailure[]> {
  return await withSessionLifecycle(sessionId, () => disposeHydratedSessionDocumentsNow(sessionId))
}

async function disposeHydratedSessionDocumentsNow(sessionId: string): Promise<HydratedSessionDisposalFailure[]> {
  const documents = sessions.get(sessionId)
  if (!documents) return []
  const failures: HydratedSessionDisposalFailure[] = []
  for (const document of Array.from(documents.values())) {
    await withDocumentLifecycle(sessionId, document.documentId, async () => {
      if (!isCurrent(document)) return
      try {
        await document.sync()
      } catch (error) {
        if (isCurrent(document)) close(document)
        failures.push({ documentId: document.documentId, path: document.path, error })
        return
      }
      try {
        if (!isCurrent(document)) return
        close(document)
        await fs.rm(path.dirname(document.path), { recursive: true, force: true })
        if (!isCurrent(document)) return
        await removeFromManifest(document)
        if (isCurrent(document)) documents.delete(document.documentId)
      } catch (error) {
        failures.push({ documentId: document.documentId, path: document.path, error })
      }
    })
  }
  if (sessions.get(sessionId) === documents && !documents.size) sessions.delete(sessionId)
  return failures
}

export function forgetHydratedSessionRuntime(sessionId: string) {
  for (const document of sessions.get(sessionId)?.values() ?? []) close(document)
  sessions.delete(sessionId)
}

async function persist(document: HydratedDocument) {
  if (!isCurrent(document)) return
  await withManifestMutation(document.manifestPath, async () => {
    if (!isCurrent(document)) return
    const manifest = await readManifest(document.manifestPath)
    manifest.documents = [
      ...manifest.documents.filter((entry) => entry.documentId !== document.documentId),
      manifestEntry(document),
    ]
    await writeManifest(document.manifestPath, manifest)
  })
}

async function removeFromManifest(document: HydratedDocument) {
  if (!isCurrent(document)) return
  await withManifestMutation(document.manifestPath, async () => {
    if (!isCurrent(document)) return
    const manifest = await readManifest(document.manifestPath)
    manifest.documents = manifest.documents.filter((entry) => entry.documentId !== document.documentId)
    await writeManifest(document.manifestPath, manifest)
  })
}

async function parkConflict(document: HydratedDocument, error: unknown) {
  document.state = "conflicted"
  document.error = error
  try {
    await persist(document)
  } catch (persistError) {
    document.error = new AggregateError([error, persistError], `Failed to persist conflict for ${document.documentId}`)
    console.error(`[session-hydration] failed to persist conflict for ${document.documentId}:`, persistError)
  }
}

async function reportWatcherError(document: HydratedDocument, error: unknown) {
  console.error(`[session-hydration] watcher failed for ${document.documentId}:`, error)
  await parkConflict(document, error)
  close(document)
}

function manifestEntry(document: HydratedDocument): ManifestEntry {
  return {
    documentId: document.documentId,
    path: document.path,
    baseVersion: document.baseVersion,
    lastSyncedHash: document.lastSyncedHash,
    state: document.state,
  }
}

function isCurrent(document: HydratedDocument) {
  return sessions.get(document.sessionId)?.get(document.documentId) === document
}

function forgetHydratedDocumentRuntime(sessionId: string, documentId: string) {
  const documents = sessions.get(sessionId)
  const document = documents?.get(documentId)
  if (!documents || !document) return
  close(document)
  if (documents.get(documentId) === document) documents.delete(documentId)
  if (!documents.size && sessions.get(sessionId) === documents) sessions.delete(sessionId)
}

async function syncHydratedDocument(document: HydratedDocument) {
  await withDocumentLifecycle(document.sessionId, document.documentId, async () => {
    if (!isCurrent(document)) return
    await document.sync()
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

async function withDocumentLifecycle<T>(sessionId: string, documentId: string, mutate: () => Promise<T>) {
  const key = JSON.stringify([sessionId, documentId])
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

async function withManifestMutation<T>(manifestPath: string, mutate: () => Promise<T>) {
  const previous = manifestMutations.get(manifestPath) ?? Promise.resolve()
  const run = previous
    .catch((error) => {
      console.error(`[session-hydration] prior manifest mutation failed for ${manifestPath}:`, error)
    })
    .then(mutate)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  manifestMutations.set(manifestPath, tail)
  try {
    return await run
  } finally {
    if (manifestMutations.get(manifestPath) === tail) manifestMutations.delete(manifestPath)
  }
}

async function readManifest(manifestPath: string): Promise<Manifest> {
  const value = await fs.readFile(manifestPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (value === undefined) return { version: 1, documents: [] }
  const parsed = JSON.parse(value) as Partial<Manifest>
  if (
    parsed.version !== 1 ||
    !Array.isArray(parsed.documents) ||
    parsed.documents.some(
      (document) =>
        !document ||
        typeof document.documentId !== "string" ||
        typeof document.path !== "string" ||
        typeof document.baseVersion !== "string" ||
        typeof document.lastSyncedHash !== "string" ||
        (document.state !== "active" && document.state !== "conflicted"),
    )
  ) {
    throw new Error("Hydrated document manifest is invalid")
  }
  return parsed as Manifest
}

async function writeManifest(manifestPath: string, manifest: Manifest) {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true, mode: 0o700 })
  const temp = `${manifestPath}.${crypto.randomUUID()}.tmp`
  const handle = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  await handle.writeFile(JSON.stringify(manifest))
  await handle.sync()
  await handle.close()
  await fs.rename(temp, manifestPath)
  const directory = await fs.open(path.dirname(manifestPath), constants.O_RDONLY)
  await directory.sync()
  await directory.close()
}

function close(document?: HydratedDocument) {
  if (!document) return
  document.watcher.close()
  if (document.timer) clearTimeout(document.timer)
}

function safeSegment(value: string) {
  return value.replaceAll(/[^a-zA-Z0-9_-]/g, "_")
}

function requireSessionId(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Session hydration id is invalid")
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

function hash(value: string) {
  return contentHash(value)
}

function inside(root: string, candidate: string) {
  return candidate === root || candidate.startsWith(root + path.sep)
}

function exists(value: string) {
  return fs.access(value).then(
    () => true,
    () => false,
  )
}

async function currentHydratedMarkdown(manifestPath: string, root: string, documentId: string) {
  const entry = (await readManifest(manifestPath)).documents.find((document) => document.documentId === documentId)
  if (!entry) throw new Error(`Hydrated document ${documentId} was not found`)
  return await readContained(root, entry.path)
}

async function readContained(root: string, target: string, beforeOpen?: () => void | Promise<void>) {
  const real = await fs.realpath(target)
  if (!inside(root, real)) throw new Error("Hydrated document manifest path escapes the workspace")
  const parent = await fs.realpath(path.dirname(target))
  const authority = await fs.stat(parent)
  const before = await fs.lstat(target)
  await beforeOpen?.()
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    const after = await fs.realpath(target).catch(() => undefined)
    const finalParent = await fs.realpath(path.dirname(target)).catch(() => undefined)
    const finalAuthority = finalParent ? await fs.stat(finalParent).catch(() => undefined) : undefined
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      !after ||
      !inside(root, after) ||
      finalParent !== parent ||
      finalAuthority?.dev !== authority.dev ||
      finalAuthority?.ino !== authority.ino
    ) {
      throw new Error("Hydrated document path changed while opening")
    }
    const { content: body, after: final } = await readBoundedFile(handle, MAX_HYDRATED_DOCUMENT_BYTES).catch(
      (error: unknown) => {
        if (error instanceof BoundedFileTooLargeError) throw new Error("Hydrated document exceeds 2 MiB")
        throw error
      },
    )
    if (
      body.byteLength !== final.size ||
      opened.dev !== final.dev ||
      opened.ino !== final.ino ||
      opened.size !== final.size ||
      opened.mtimeMs !== final.mtimeMs
    ) {
      throw new Error("Hydrated document changed while reading")
    }
    if (body.includes(0)) throw new Error("Hydrated document is not valid UTF-8 text")
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body)
    } catch (error) {
      throw new Error("Hydrated document is not valid UTF-8 text", { cause: error })
    }
  } finally {
    await handle.close()
  }
}

async function writeContained(root: string, target: string, content: string, beforeOpen?: () => void | Promise<void>) {
  const parent = await fs.realpath(path.dirname(target))
  if (!inside(root, parent)) throw new Error("Hydrated document path escapes the workspace")
  await beforeOpen?.()
  const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600)
  const opened = await handle.stat()
  const final = await fs.lstat(target).catch(() => undefined)
  const real = await fs.realpath(target).catch(() => undefined)
  if (
    !opened.isFile() ||
    !final?.isFile() ||
    opened.dev !== final.dev ||
    opened.ino !== final.ino ||
    !real ||
    !inside(root, real)
  ) {
    await handle.close()
    throw new Error("Hydrated document path changed while opening")
  }
  await handle.truncate(0)
  await handle.writeFile(content)
  await handle.sync()
  await handle.close()
}
