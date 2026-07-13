import path from "node:path"
import fs from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { ResolvedExecutionProfile, WorkGraphContext } from "@claxedo/workgraph/contracts"
import type {
  ChildIsolationID,
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
      sessionId?: string
      directory: string
      title: string
      prompt: string
      profile: ResolvedExecutionProfile
      context?: WorkGraphContext
    }>,
  ) => Promise<string>
  cancel: (sessionId: string, reason: string) => Promise<void>
  result: (sessionId: string) => Promise<ExecutionResult>
}>

export function createLocalWorkspaceExecution(
  input: Readonly<{
    worktreeRoot: string
    repositoryDirectory: (baseRevision: string) => Promise<string>
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
  const ownerRoot = (ownerUserId: string) => contained(path.join(input.worktreeRoot, encode(ownerUserId)))
  const streamRoot = (ownerUserId: string, streamId: string) =>
    contained(path.join(ownerRoot(ownerUserId), encode(streamId)))
  const envelopeDirectory = (ownerUserId: string, streamId: string) =>
    contained(path.join(streamRoot(ownerUserId, streamId), "envelope"))
  const childDirectory = (ownerUserId: string, streamId: string, attemptId: string) =>
    contained(path.join(streamRoot(ownerUserId, streamId), "children", encode(attemptId)))
  const removeWorktree = async (directory: string) => {
    if (!(await exists(directory))) return
    const common = (
      await run("git", ["-C", directory, "rev-parse", "--path-format=absolute", "--git-common-dir"])
    ).stdout.trim()
    await run("git", ["--git-dir", common, "worktree", "remove", "--force", directory])
  }

  return {
    provisionOrAdopt: async (context, request) =>
      serialize(`${context.ownerUserId}:${request.streamId}`, async () => {
        if (request.environment.kind !== "local_worktree" || !request.repository)
          throw new Error("Local execution requires a repository target")
        const directory = envelopeDirectory(context.ownerUserId, request.streamId)
        const envelopeId =
          request.envelopeId ??
          (`envelope_${encode(context.ownerUserId)}_${encode(request.streamId)}` as StreamEnvelopeID)
        if (!(await exists(path.join(directory, ".git")))) {
          const repository = await input.repositoryDirectory(request.repository.baseRevision)
          await fs.mkdir(path.dirname(directory), { recursive: true })
          await run("git", [
            "-C",
            repository,
            "worktree",
            "add",
            "--detach",
            directory,
            request.repository.baseRevision,
          ])
        }
        return {
          id: envelopeId,
          streamId: request.streamId,
          environment: request.environment,
          repository: request.repository,
          workspaceId: directory,
        }
      }),
    createChildIsolation: async (context, request) =>
      serialize(`${context.ownerUserId}:${request.streamId}`, async () => {
        const envelope = envelopeDirectory(context.ownerUserId, request.streamId)
        if (!(await exists(path.join(envelope, ".git")))) throw new Error("Stream envelope is not provisioned")
        const directory = childDirectory(context.ownerUserId, request.streamId, request.attemptId)
        await fs.mkdir(path.dirname(directory), { recursive: true })
        if (!(await exists(path.join(directory, ".git")))) {
          await run("git", ["-C", envelope, "worktree", "add", "--detach", directory, "HEAD"])
        }
        return {
          id: `child_${encode(context.ownerUserId)}_${encode(request.attemptId)}` as ChildIsolationID,
          envelopeId: request.envelopeId,
          workItemId: request.workItemId,
          workspaceId: directory,
        }
      }),
    launch: async (context, request) => {
      if (request.connectionIds.length > 0 && !input.sessions.supportsConnections) {
        throw new Error("Connection-bound Attempts require a Session connection capability bridge")
      }
      const directory = request.childIsolationId
        ? childDirectory(context.ownerUserId, request.streamId, request.attemptId)
        : envelopeDirectory(context.ownerUserId, request.streamId)
      if (!(await exists(path.join(directory, ".git")))) throw new Error("Execution workspace is not provisioned")
      return {
        sessionId: (await input.sessions.admit({
          attemptId: request.attemptId,
          directory,
          title: String(request.workItemId),
          prompt: request.prompt,
          profile: request.profile,
          context,
        })) as ExecutionSessionID,
        envelopeId: request.envelopeId,
        ...(request.childIsolationId ? { childIsolationId: request.childIsolationId } : {}),
      }
    },
    cancel: async (_context, request) => input.sessions.cancel(request.sessionId, request.reason),
    result: async (_context, request) => input.sessions.result(request.sessionId),
    integrateResult: async (_context, request) => ({
      summary: request.result.summary,
      artifacts: request.result.artifacts,
    }),
    cleanup: async (context, request) =>
      serialize(`${context.ownerUserId}:${request.streamId}`, async () => {
        if (request.reason === "close" && request.cleanupPolicy !== "destroy_on_close") return
        const root = streamRoot(context.ownerUserId, request.streamId)
        const childrenRoot = path.join(root, "children")
        const selected = request.childIsolationIds
          ?.map((id) => {
            const prefix = `child_${encode(context.ownerUserId)}_`
            const encodedAttempt = String(id).startsWith(prefix) ? String(id).slice(prefix.length) : undefined
            return encodedAttempt ? contained(path.join(childrenRoot, encodedAttempt)) : undefined
          })
          .filter((directory): directory is string => !!directory)
        const children =
          selected ??
          (await fs.readdir(childrenRoot, { withFileTypes: true }).then(
            (entries) =>
              entries
                .filter((entry) => entry.isDirectory())
                .map((entry) => contained(path.join(childrenRoot, entry.name))),
            () => [],
          ))
        for (const child of children) await removeWorktree(child)
        if (request.reason === "reconcile") return
        await removeWorktree(envelopeDirectory(context.ownerUserId, request.streamId))
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
