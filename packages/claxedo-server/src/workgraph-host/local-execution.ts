import path from "node:path"
import fs from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { ResolvedExecutionProfile, WorkGraphContext } from "@claxedo/workgraph/contracts"
import type {
  ExecutionResult,
  ExecutionSessionID,
  StreamEnvelopeID,
  WorkspaceExecutionPort,
} from "@claxedo/workgraph"

/** A gateway to durable Session V2 admission, interruption, and semantic result projection. */
export type WorkGraphSessionGateway = Readonly<{
  supportsConnections?: boolean
  classifyAdmissionError?: (error: unknown) => "unavailable" | "rejected" | "indeterminate"
  admit: (
    input: Readonly<{
      attemptId: string
      leaseEpoch?: number
      sessionId?: string
      directory: string
      workspaceId?: string
      title: string
      prompt: string
      profile: ResolvedExecutionProfile
      context?: WorkGraphContext
    }>,
  ) => Promise<string>
  cancel: (sessionId: string, reason: string) => Promise<void>
  result: (sessionId: string) => Promise<ExecutionResult>
  releaseDirectory?: (directory: string) => Promise<void>
}>

export type WorkGraphWorktreeGateway = Readonly<{
  provision(input: Readonly<{
    repositoryDirectory: string
    directory: string
    baseRevision: string
    streamId: string
  }>): Promise<Readonly<{ directory: string; workspaceId: string }>>
  release(directory: string): Promise<void>
}>

export function createLocalWorkspaceExecution(
  input: Readonly<{
    worktreeRoot: string
    legacyRepositoryDirectory?: (baseRevision: string) => Promise<string>
    /** Compatibility for persisted pre-target Streams and older host compositions. */
    repositoryDirectory?: (baseRevision: string) => Promise<string>
    worktrees?: WorkGraphWorktreeGateway
    sessions: WorkGraphSessionGateway
  }>,
): WorkspaceExecutionPort {
  const run = promisify(execFile)
  const locks = new Map<string, Promise<void>>()
  const serialize = async <Value>(key: string, effect: () => Promise<Value>) => {
    const previous = locks.get(key) ?? Promise.resolve()
    let release = () => {}
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => current)
    locks.set(key, tail)
    await previous
    try {
      return await effect()
    } finally {
      release()
      if (locks.get(key) === tail) locks.delete(key)
    }
  }
  const contained = (candidate: string) => {
    const root = path.resolve(input.worktreeRoot)
    const resolved = path.resolve(candidate)
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))
      throw new Error("WorkGraph workspace escaped its configured root")
    return resolved
  }
  const ownerRoot = (context: WorkGraphContext) => contained(path.join(
    input.worktreeRoot,
    encode(context.organizationId),
    encode(context.ownerUserId),
  ))
  const streamRoot = (context: WorkGraphContext, streamId: string) =>
    contained(path.join(ownerRoot(context), encode(streamId)))
  const envelopeDirectory = (context: WorkGraphContext, streamId: string) =>
    contained(path.join(streamRoot(context, streamId), "envelope"))
  const removeWorktree = async (directory: string) => {
    await input.sessions.releaseDirectory?.(directory)
    if (input.worktrees) return input.worktrees.release(directory)
    if (!(await exists(directory))) return
    const common = (
      await run("git", ["-C", directory, "rev-parse", "--path-format=absolute", "--git-common-dir"])
    ).stdout.trim()
    await run("git", ["--git-dir", common, "worktree", "remove", "--force", directory])
  }

  return {
    provisionOrAdopt: async (context, request) =>
      serialize(JSON.stringify([context.organizationId, context.ownerUserId, request.streamId]), async () => {
        if (request.environment.kind !== "local_worktree" || !request.repository)
          throw new Error("Local execution requires a repository target")
        const repositoryTarget = request.repository
        const directory = envelopeDirectory(context, request.streamId)
        const envelopeId =
          request.envelopeId ??
          (`envelope_${encode(context.organizationId)}.${encode(context.ownerUserId)}.${encode(request.streamId)}` as StreamEnvelopeID)
        const repository = request.environment.directory?.trim() ??
          await (input.legacyRepositoryDirectory ?? input.repositoryDirectory)?.(repositoryTarget.baseRevision)
        if (!repository) throw new Error("Local execution requires the Stream's project directory")
        if (!path.isAbsolute(repository)) throw new Error("Local execution requires an absolute project directory")
        const workspaceId = await (async () => {
          if (input.worktrees) {
            return (await input.worktrees.provision({
              repositoryDirectory: repository,
              directory,
              baseRevision: repositoryTarget.baseRevision,
              streamId: request.streamId,
            })).workspaceId
          }
          if (!(await exists(path.join(directory, ".git")))) {
            await run("git", ["-C", repository, "rev-parse", "--show-toplevel"])
            await fs.mkdir(path.dirname(directory), { recursive: true })
            await run("git", [
              "-C",
              repository,
              "worktree",
              "add",
              "--detach",
              directory,
              repositoryTarget.baseRevision,
            ])
          }
          return directory
        })()
        return {
          id: envelopeId,
          streamId: request.streamId,
          environment: request.environment,
          repository: repositoryTarget,
          workspaceId,
        }
      }),
    launch: async (context, request) => {
      if (request.connectionIds.length > 0 && !input.sessions.supportsConnections) {
        throw new Error("Connection-bound Attempts require a Session connection capability bridge")
      }
      const directory = envelopeDirectory(context, request.streamId)
      if (!(await exists(path.join(directory, ".git")))) throw new Error("Execution workspace is not provisioned")
      return {
        sessionId: (await input.sessions.admit({
          attemptId: request.attemptId,
          leaseEpoch: request.leaseEpoch,
          directory,
          workspaceId: request.workspaceId,
          title: String(request.workItemId),
          prompt: request.prompt,
          profile: request.profile,
          context,
        })) as ExecutionSessionID,
        envelopeId: request.envelopeId,
        projectId: request.workspaceId,
      }
    },
    cancel: async (_context, request) => input.sessions.cancel(request.sessionId, request.reason),
    result: async (_context, request) => input.sessions.result(request.sessionId),
    cleanup: async (context, request) =>
      serialize(JSON.stringify([context.organizationId, context.ownerUserId, request.streamId]), async () => {
        const root = streamRoot(context, request.streamId)
        const childrenRoot = path.join(root, "children")
        const selected = request.childIsolationIds
          ?.map((id) => {
            const prefix = `child_${encode(context.organizationId)}.${encode(context.ownerUserId)}.`
            const encodedAttempt = String(id).startsWith(prefix) ? String(id).slice(prefix.length) : undefined
            return encodedAttempt ? contained(path.join(childrenRoot, encodedAttempt)) : undefined
          })
          .filter((directory): directory is string => !!directory)
        const children =
          selected ??
          (request.reason === "reconcile"
            ? []
            : await fs.readdir(childrenRoot, { withFileTypes: true }).then(
                (entries) =>
                  entries
                    .filter((entry) => entry.isDirectory())
                    .map((entry) => contained(path.join(childrenRoot, entry.name))),
                () => [],
              ))
        for (const child of children) await removeWorktree(child)
        if (request.reason === "reconcile") return
        const directory = envelopeDirectory(context, request.streamId)
        await removeWorktree(directory)
        await fs.rm(root, { recursive: true, force: true })
      }),
  }
}

function encode(value: string) {
  return Buffer.from(value).toString("base64url")
}

function exists(candidate: string) {
  return fs.stat(candidate).then(
    () => true,
    () => false,
  )
}
