import fs from "node:fs"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import type { ErrorReportContext } from "../observability/report"
import type { SessionMeta } from "../session-meta-types"
import type { Workspace } from "../workspace-store"
import { DocumentAgentOpenError, type DocumentsBackend } from "./backend"
import { DocumentNotFoundError, DocumentStorageError } from "./errors"
import {
  archiveDocumentIndexEntry,
  createDocumentIndexEntry,
  findDocumentIndexEntry,
  findRepositoryDocumentIndexEntry,
  listDocumentIndex,
  listDocumentStatuses,
  moveManagedDocumentIndexToRepository,
  removeDocumentIndexEntry,
  relocateRepositoryDocumentIndexEntry,
  resolveLocalProjectId,
  restoreRepositoryMoveToManaged,
  restoreDocumentIndexEntry,
  transitionDocumentStatus,
  updateDocumentIndexMetadata,
  type DocumentIndexEntry,
} from "./index-store"
import {
  createLocalManagedDocumentWorkspace,
  managedDocumentRelativePath,
  type LocalManagedDocumentHandle,
  type LocalManagedOptions,
} from "./local-managed"
import { createMoveToRepository } from "./move-to-repository"
import type { DocumentEntry, DocumentVersion } from "./port"
import {
  createLocalRepositoryFileAuthority,
  createLocalRepositoryGitAuthority,
  createRepositoryDocumentWorkspace,
  type RepositoryDocumentHandle,
} from "./repository"
import { sessionMatchesDocumentProject } from "./session-grants"
import { hydrateSessionDocument, reachableLocalSessionWorkspace } from "./session-hydration"
import { createDocumentWatchService } from "./watch"

type Handle = LocalManagedDocumentHandle | RepositoryDocumentHandle

export type LocalDocumentsBackendDependencies = Readonly<{
  resolveWorkspace(input: Readonly<{ workspaceId?: string; directory?: string }>): Promise<Workspace | undefined>
  sessionMeta(sessionId: string): Promise<SessionMeta | undefined>
  dataDir(): string
  reportError(error: unknown, context?: ErrorReportContext): void
  runGit(
    args: readonly string[],
    directory: string,
    options?: Readonly<{
      env?: Readonly<Record<string, string>>
      timeoutMs?: number
      maxBufferBytes?: number
    }>,
  ): Promise<string>
}>

export type LocalDocumentsBackendOptions = Readonly<{
  managed?: Omit<LocalManagedOptions, "dataRoot">
}>

export function createLocalDocumentsBackend(
  dependencies: LocalDocumentsBackendDependencies,
  options: LocalDocumentsBackendOptions = {},
) {
  const dataRoot = dependencies.dataDir()
  const managed = createLocalManagedDocumentWorkspace({ ...options.managed, dataRoot })
  const repository = createRepositoryDocumentWorkspace({
    workspace: {
      resolve: async (workspaceId) => {
        const workspace = await dependencies.resolveWorkspace({ workspaceId })
        return workspace?.kind === "local" ? { directory: workspace.directory } : undefined
      },
    },
    files: createLocalRepositoryFileAuthority(),
    git: createLocalRepositoryGitAuthority(async (args, directory, options) => {
      try {
        return await dependencies.runGit(args, directory, {
          ...(options?.env ? { env: options.env } : {}),
          timeoutMs: 10_000,
          maxBufferBytes: 50 * 1024 * 1024,
        })
      } catch (error) {
        throw new DocumentStorageError("document_storage_failed", "running repository Git", { cause: error })
      }
    }),
  })
  const workspace = {
    create: managed.create,
    resolve: async (entry: DocumentEntry): Promise<Handle> => {
      if (entry.origin === "managed") return await managed.resolve(entry)
      await requireAuthorizedRepositoryWorkspace(entry)
      return await repository.resolve(entry)
    },
    read: (handle: Handle) => (handle.origin === "managed" ? managed.read(handle) : repository.read(handle)),
    write: (handle: Handle, request: Parameters<typeof managed.write>[1]) =>
      handle.origin === "managed" ? managed.write(handle, request) : repository.write(handle, request),
    snapshot: (handle: Handle, request: Parameters<typeof managed.snapshot>[1]) =>
      handle.origin === "managed" ? managed.snapshot(handle, request) : repository.snapshot(handle, request),
    listSnapshots: (handle: Handle) =>
      handle.origin === "managed" ? managed.listSnapshots(handle) : repository.listSnapshots(handle),
    readSnapshot: (handle: Handle, snapshotId: Parameters<typeof managed.readSnapshot>[1]) =>
      handle.origin === "managed"
        ? managed.readSnapshot(handle, snapshotId)
        : repository.readSnapshot(handle, snapshotId),
    pinSnapshot: (handle: Handle, snapshotId: Parameters<typeof managed.pinSnapshot>[1], pin: string) =>
      handle.origin === "managed"
        ? managed.pinSnapshot(handle, snapshotId, pin)
        : repository.pinSnapshot(handle, snapshotId, pin),
    unpinSnapshot: (handle: Handle, snapshotId: Parameters<typeof managed.unpinSnapshot>[1], pin: string) =>
      handle.origin === "managed"
        ? managed.unpinSnapshot(handle, snapshotId, pin)
        : repository.unpinSnapshot(handle, snapshotId, pin),
    collectSnapshots: (handle: Handle) =>
      handle.origin === "managed" ? managed.collectSnapshots(handle) : repository.collectSnapshots(handle),
    restore: (
      handle: Handle,
      snapshotId: Parameters<typeof managed.restore>[1],
      request: Parameters<typeof managed.restore>[2],
    ) =>
      handle.origin === "managed"
        ? managed.restore(handle, snapshotId, request)
        : repository.restore(handle, snapshotId, request),
  }
  const documentWatch = createDocumentWatchService({
    read: (handle: Handle) => workspace.read(handle),
    snapshot: (handle: Handle, request) => workspace.snapshot(handle, request),
    onChange: () => {},
    onError: (error, handle) => {
      dependencies.reportError(error, {
        tags: { source: "document_watch" },
        extra: { documentId: handle.documentId, projectId: handle.projectId },
      })
      console.error(`[document-watch] ${handle.documentId}:`, error)
    },
  })

  async function requireAuthorizedRepositoryWorkspace(entry: Extract<DocumentEntry, { origin: "repository" }>) {
    return await requireProjectWorkspace(entry.workspaceId, entry.projectId, entry.documentId)
  }

  async function requireProjectWorkspace(workspaceId: string, projectId: string, notFoundId: string) {
    const resolved = await dependencies.resolveWorkspace({ workspaceId })
    if (!resolved || resolved.kind !== "local") throw new DocumentNotFoundError(notFoundId)
    const projectIds = new Set(
      [resolved.id, resolved.project_id, resolveLocalProjectId(resolved.directory)].filter(
        (value): value is string => !!value,
      ),
    )
    if (!projectIds.has(projectId)) throw new DocumentNotFoundError(notFoundId)
    return resolved
  }

  function repositoryIdentity(value: string) {
    return `repository_file_${createHash("sha256").update(value).digest("hex")}`
  }

  function requireRepositoryDocumentEntry(entry: DocumentEntry) {
    if (entry.origin !== "repository") throw new DocumentNotFoundError(entry.documentId)
    return entry
  }

  async function repositoryMoveTarget(workspaceId: string, relativePath: string, projectId: string) {
    const resolved = await requireProjectWorkspace(workspaceId, projectId, workspaceId)
    const root = await fs.promises.realpath(resolved.directory)
    const target = path.resolve(root, relativePath)
    if (target === root || !target.startsWith(root + path.sep)) throw new DocumentNotFoundError(relativePath)
    await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    const parent = await fs.promises.realpath(path.dirname(target))
    if (parent !== root && !parent.startsWith(root + path.sep)) throw new DocumentNotFoundError(relativePath)
    const authority = await fs.promises.stat(parent)
    return {
      root,
      target,
      relativePath: path.relative(root, target),
      parent,
      authority: { dev: authority.dev, ino: authority.ino },
    }
  }

  return {
    index: {
      list: listDocumentIndex,
      find: findDocumentIndexEntry,
      findRepository: findRepositoryDocumentIndexEntry,
      create: createDocumentIndexEntry,
      remove: removeDocumentIndexEntry,
      update: updateDocumentIndexMetadata,
      relocate: relocateRepositoryDocumentIndexEntry,
      archive: archiveDocumentIndexEntry,
      restore: restoreDocumentIndexEntry,
      listStatuses: listDocumentStatuses,
      transitionStatus: transitionDocumentStatus,
      resolveLocalProjectId,
    },
    workspace,
    managedRelativePath: managedDocumentRelativePath,
    placement: "local",
    placementId: "local",
    repository: {
      async inspect(input: DocumentEntry) {
        const entry = requireRepositoryDocumentEntry(input)
        await requireAuthorizedRepositoryWorkspace(entry)
        const handle = await repository.resolve(entry)
        return {
          identityKey: repositoryIdentity(await repository.identityKey(entry)),
          relativePath: handle.relativePath,
          availability: await repository.availability(entry),
        }
      },
      async availability(input: DocumentEntry, expectedVersion?: Parameters<typeof repository.availability>[1]) {
        const entry = requireRepositoryDocumentEntry(input)
        await requireAuthorizedRepositoryWorkspace(entry)
        return await repository.availability(entry, expectedVersion)
      },
      async relocate(
        input: DocumentEntry,
        relativePath: string,
        expectedVersion: Parameters<typeof repository.relocate>[2],
      ) {
        const entry = requireRepositoryDocumentEntry(input)
        await requireAuthorizedRepositoryWorkspace(entry)
        const handle = await repository.relocate(entry, relativePath, expectedVersion)
        return {
          identityKey: repositoryIdentity(
            await repository.identityKey({ ...entry, relativePath: handle.relativePath }),
          ),
          relativePath: handle.relativePath,
          version: (await repository.read(handle)).version,
        }
      },
      async gitSnapshot(input: DocumentEntry) {
        const entry = requireRepositoryDocumentEntry(input)
        await requireAuthorizedRepositoryWorkspace(entry)
        return await repository.gitSnapshot(await repository.resolve(entry))
      },
      async commit(
        input: DocumentEntry,
        request: { message: string; expected: { baseCommit?: string; baseBlobSha?: string } },
      ) {
        const entry = requireRepositoryDocumentEntry(input)
        await requireAuthorizedRepositoryWorkspace(entry)
        const handle = await repository.resolve(entry)
        const committed = await repository.commit(handle, {
          markdown: (await repository.read(handle)).markdown,
          ...request,
        })
        return { ...committed, version: (await repository.read(handle)).version }
      },
    },
    async moveToRepository(entry: DocumentIndexEntry, destination: { workspaceId: string; relativePath: string }) {
      const move = createMoveToRepository({
        journalRoot: path.join(dataRoot, "document-moves"),
        validateDestination: async (input) => {
          const destination = await repositoryMoveTarget(input.workspaceId, input.relativePath, input.projectId)
          const repositoryRoot = await dependencies
            .runGit(["rev-parse", "--show-toplevel"], destination.root, {
              timeoutMs: 10_000,
            })
            .catch((error) => {
              throw new DocumentStorageError(
                "document_storage_failed",
                "repository destination is not a Git workspace",
                { cause: error },
              )
            })
          if ((await fs.promises.realpath(repositoryRoot)) !== destination.root) {
            throw new DocumentStorageError(
              "document_storage_failed",
              "repository destination must use the workspace Git root",
            )
          }
        },
        readManaged: async (input) => {
          const read = await managed.read(
            await managed.resolve({
              origin: "managed",
              placement: "local",
              projectId: input.projectId,
              documentId: input.documentId,
              relativePath: input.managedRelativePath!,
            }),
          )
          return { markdown: read.markdown, version: read.version }
        },
        writeRepository: async (markdown, input) => {
          const destination = await repositoryMoveTarget(input.workspaceId, input.relativePath, input.projectId)
          const existing = await fs.promises
            .readFile(destination.target, "utf8")
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return undefined
              throw error
            })
          if (existing !== undefined) {
            if (existing !== markdown)
              throw new DocumentStorageError(
                "document_storage_failed",
                "repository destination already contains different content",
              )
            return
          }
          const temporary = path.join(destination.root, `.claxedo-document-move-${randomUUID()}.tmp`)
          const file = await fs.promises.open(temporary, "wx", 0o600)
          try {
            await file.writeFile(markdown)
            await file.sync()
          } finally {
            await file.close()
          }
          try {
            await fs.promises.link(temporary, destination.target)
            const parent = await fs.promises.realpath(path.dirname(destination.target))
            const authority = await fs.promises.stat(parent)
            if (
              parent !== destination.parent ||
              authority.dev !== destination.authority.dev ||
              authority.ino !== destination.authority.ino
            ) {
              const [claimed, installed] = await Promise.all([
                fs.promises.stat(temporary),
                fs.promises.stat(destination.target).catch(() => undefined),
              ])
              if (installed && claimed.dev === installed.dev && claimed.ino === installed.ino) {
                await fs.promises.unlink(destination.target)
              }
              throw new DocumentStorageError(
                "document_storage_failed",
                "repository destination parent changed during move",
              )
            }
          } catch (error) {
            if (error instanceof DocumentStorageError) throw error
            const current = await fs.promises.readFile(destination.target, "utf8").catch(() => undefined)
            if (current !== markdown) throw error
          } finally {
            await fs.promises.unlink(temporary).catch(() => undefined)
          }
        },
        readRepository: async (input) =>
          await fs.promises
            .readFile(
              (await repositoryMoveTarget(input.workspaceId, input.relativePath, input.projectId)).target,
              "utf8",
            )
            .catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? undefined : Promise.reject(error))),
        indexOrigin: async (input) => findDocumentIndexEntry(input.orgId, input.documentId)?.origin_kind,
        flipIndex: async (input, sourceVersion, expected) => {
          const destination = await repositoryMoveTarget(input.workspaceId, input.relativePath, input.projectId)
          const repositoryEntry: DocumentEntry = {
            origin: "repository",
            placement: "local",
            projectId: input.projectId,
            documentId: input.documentId,
            workspaceId: input.workspaceId,
            relativePath: destination.relativePath,
          }
          const handle = await repository.resolve(repositoryEntry)
          const read = await repository.read(handle)
          const managedRead = await managed.read(
            await managed.resolve({
              origin: "managed",
              placement: "local",
              projectId: input.projectId,
              documentId: input.documentId,
              relativePath: input.managedRelativePath!,
            }),
          )
          if (managedRead.version !== sourceVersion || managedRead.markdown !== expected.markdown) {
            throw new DocumentStorageError(
              "document_storage_failed",
              "managed source changed before repository index flip",
            )
          }
          if (
            read.markdown !== expected.markdown ||
            createHash("sha256").update(Buffer.from(read.markdown)).digest("hex") !== expected.sha256
          ) {
            throw new DocumentStorageError(
              "document_storage_failed",
              "repository destination changed before index flip",
            )
          }
          moveManagedDocumentIndexToRepository({ orgId: input.orgId, projectId: input.projectId }, input.documentId, {
            repository_id: repositoryIdentity(await repository.identityKey(repositoryEntry)),
            workspace_id: input.workspaceId,
            repository_relative_path: destination.relativePath,
            last_known_file_version: read.version,
          })
        },
        archiveManaged: async (input, expectedVersion) => {
          const handle = await managed.resolve({
            origin: "managed",
            placement: "local",
            projectId: input.projectId,
            documentId: input.documentId,
            relativePath: input.managedRelativePath!,
          })
          await managed.archiveExact(handle, {
            archivePath: path.join(
              dataRoot,
              "document-move-archive",
              input.documentId,
              `${createHash("sha256").update(expectedVersion).digest("hex")}.md`,
            ),
            expectedVersion: expectedVersion as DocumentVersion,
          })
        },
        restoreManagedIndex: async (input) => {
          const handle = await managed.resolve({
            origin: "managed",
            placement: "local",
            projectId: input.projectId,
            documentId: input.documentId,
            relativePath: input.managedRelativePath!,
          })
          const current = await managed.read(handle)
          restoreRepositoryMoveToManaged({ orgId: input.orgId, projectId: input.projectId }, input.documentId, {
            managed_relative_path: input.managedRelativePath!,
            last_known_file_version: current.version,
          })
        },
      })
      const moved = await move({
        orgId: entry.org_id,
        projectId: entry.project_id,
        documentId: entry.id,
        workspaceId: destination.workspaceId,
        relativePath: destination.relativePath,
        ...(entry.origin_kind === "managed" ? { managedRelativePath: entry.managed_relative_path } : {}),
      })
      const updated = findDocumentIndexEntry(moved.orgId, moved.documentId)
      if (!updated) throw new DocumentNotFoundError(moved.documentId)
      return updated
    },
    watch: {
      async open(entry: DocumentIndexEntry, onChange: Parameters<typeof documentWatch.open>[2]) {
        const handle = await workspace.resolve(
          entry.origin_kind === "managed"
            ? {
                origin: "managed",
                placement: "local",
                orgId: entry.org_id,
                projectId: entry.project_id,
                documentId: entry.id,
                relativePath: entry.managed_relative_path,
              }
            : {
                origin: "repository",
                placement: "local",
                orgId: entry.org_id,
                projectId: entry.project_id,
                documentId: entry.id,
                workspaceId: entry.workspace_id,
                relativePath: entry.repository_relative_path,
              },
        )
        return documentWatch.open(handle, (await workspace.read(handle)).version, onChange)
      },
    },
    async agentOpen(entry: DocumentIndexEntry, sessionId: string) {
      if (entry.placement_kind !== "local") {
        throw new DocumentAgentOpenError(
          409,
          "document_placement_unreachable",
          "Hosted documents require session hydration",
        )
      }
      const session = await dependencies.sessionMeta(sessionId)
      if (!session) throw new DocumentAgentOpenError(404, "document_session_not_found", "Session not found")
      if (
        !sessionMatchesDocumentProject({
          documentProjectId: entry.project_id,
          ...(session.projectID ? { sessionProjectId: session.projectID } : {}),
          ...(session.directory ? { sessionDirectory: session.directory } : {}),
          resolveDirectoryProjectId: resolveLocalProjectId,
        })
      ) {
        throw new DocumentAgentOpenError(
          403,
          "document_session_project_mismatch",
          "Session does not belong to this document's project",
        )
      }
      const placement = await reachableLocalSessionWorkspace({
        host: session.host,
        ...(session.workspaceID ? { workspaceId: session.workspaceID } : {}),
        ...(session.directory ? { directory: session.directory } : {}),
        ...(session.toolSandbox ? { toolSandbox: session.toolSandbox } : {}),
        resolveWorkspace: (workspaceId) => dependencies.resolveWorkspace({ workspaceId }),
      })
      if (!placement) {
        throw new DocumentAgentOpenError(
          409,
          "document_placement_unreachable",
          "Session placement cannot reach local documents",
        )
      }
      const sessionWorkspaceId = placement.workspaceId
      const workspaceRoot = placement.root
      if (entry.origin_kind === "repository") {
        if (sessionWorkspaceId !== entry.workspace_id) {
          throw new DocumentAgentOpenError(
            409,
            "document_placement_unreachable",
            "Repository document is outside this session's workspace",
          )
        }
        const repositoryWorkspace = await dependencies.resolveWorkspace({ workspaceId: entry.workspace_id })
        if (!repositoryWorkspace || repositoryWorkspace.kind !== "local") {
          throw new DocumentAgentOpenError(
            409,
            "document_placement_unreachable",
            "Repository workspace is unavailable locally",
          )
        }
        const root = await fs.promises.realpath(repositoryWorkspace.directory)
        const canonicalPath = await fs.promises.realpath(path.resolve(root, entry.repository_relative_path))
        if (canonicalPath !== root && !canonicalPath.startsWith(root + path.sep)) {
          throw new DocumentAgentOpenError(
            403,
            "document_path_invalid",
            "Repository document path escapes its workspace",
          )
        }
        return { path: canonicalPath }
      }
      const handle = await workspace.resolve({
        origin: "managed",
        placement: "local",
        projectId: entry.project_id,
        documentId: entry.id,
        relativePath: entry.managed_relative_path,
      })
      const read = await workspace.read(handle)
      return {
        path: await hydrateSessionDocument({
          sessionId,
          workspaceRoot,
          documentId: entry.id,
          displayName: entry.display_name,
          markdown: read.markdown,
          baseVersion: read.version,
          sync: async (markdown, expectedVersion) => {
            const written = await workspace.write(handle, {
              markdown,
              expectedVersion: expectedVersion as DocumentVersion,
              actor: { type: "agent", id: sessionId },
              sessionId,
            })
            updateDocumentIndexMetadata({ orgId: entry.org_id, projectId: entry.project_id }, entry.id, {
              last_known_file_version: written.version,
            })
            return written.version
          },
        }),
      }
    },
  } satisfies DocumentsBackend<Handle>
}
