import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Hono, type Context } from "hono"
import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose"
import type { RelayHostAuthContext } from "@claxedo/session-core/relay-host"
import type { WorkspaceRuntimeServerOptions } from "@claxedo/workspace-runtime"
import {
  HOST_MANAGEMENT_GRANT_HEADER,
  HOST_MANAGEMENT_ROUTES,
  verifyHostManagementGrant,
  type HostManagementOperation,
} from "@claxedo/server-core/platform/auth/host-management-grant"
import { cloneInto, RepositoryCloneError } from "@claxedo/server-core/hosts/machine/clone"
import { directoryEntries, searchFolders } from "@claxedo/server-core/hosts/machine/folders"
import { addGitWorktree, nextWorktreeInfo, resolveWorktreeCheckout, WorktreeProvisionError } from "@claxedo/server-core/hosts/machine/worktree"
import { readField, readFiniteNumber, readRecord, readString } from "@claxedo/helpers/readers"

export type HostManagementOptions = {
  enrollmentId: string
  hostId: string
  /** The control plane's published key set, which signs every grant. */
  controlPlaneKeys: JWTVerifyGetKey
  now?: () => number
}

export type HostManagement = {
  readonly contribution: NonNullable<WorkspaceRuntimeServerOptions["routeContributions"]>[number]
}

type Refusal = { status: 400 | 401 | 403 | 404 | 409 | 502; code: string; message: string }

const MAX_SEARCH_RESULTS = 200

function answerRefusal(c: Context, refusal: Refusal) {
  return c.json({ error: { code: refusal.code, message: refusal.message } }, refusal.status)
}

function createSpentGrants(now: () => number) {
  const spent = new Map<string, number>()
  return (jti: string, expiresAt: number) => {
    const at = now()
    for (const [id, until] of spent) if (until <= at) spent.delete(id)
    if (spent.has(jti)) return false
    spent.set(jti, expiresAt)
    return true
  }
}

type Env = { Variables: RelayHostAuthContext }

function relayedOwner(c: Context<Env>) {
  const claims = c.get("relayHostAuth")
  if (!claims || claims.principal_kind !== "user" || claims.role !== "owner" || claims.session_id !== undefined) return undefined
  return claims.user_id
}

function createAdmission(options: HostManagementOptions, key: JWTVerifyGetKey) {
  const now = options.now ?? Date.now
  const spend = createSpentGrants(now)
  return async (c: Context<Env>, operation: HostManagementOperation, destination: string): Promise<Refusal | undefined> => {
    const person = relayedOwner(c)
    if (!person) return { status: 403, code: "host_management_owner_required", message: "Only the machine's owner manages it" }
    const token = c.req.header(HOST_MANAGEMENT_GRANT_HEADER)?.trim()
    if (!token) return { status: 401, code: "host_management_grant_required", message: "This operation needs a grant from the control plane" }
    const grant = await verifyHostManagementGrant(token, key, { now })
    if (!grant || grant.enrollmentId !== options.enrollmentId || grant.hostId !== options.hostId) {
      return { status: 403, code: "host_management_grant_invalid", message: "The grant is not this machine's, or it expired" }
    }
    if (grant.ownerUserId !== person || grant.operation !== operation || grant.destination !== destination) {
      return { status: 403, code: "host_management_grant_mismatch", message: "The grant names another person, operation or destination" }
    }
    if (!spend(grant.jti, grant.expiresAt)) return { status: 409, code: "host_management_grant_spent", message: "The grant was already used" }
    return undefined
  }
}

function nonBlankField(body: unknown, name: string): string | undefined {
  const value = readString(body, name)
  return value?.trim() ? value : undefined
}

function folderFailure(error: unknown, directory: string): Refusal {
  const code = readString(error, "code")
  if (code === "ENOENT" || code === "ENOTDIR") return { status: 404, code: "folder_not_found", message: `${directory} is not a folder on this machine` }
  if (code === "EACCES" || code === "EPERM") return { status: 403, code: "folder_unreadable", message: `This machine cannot read ${directory}` }
  throw error
}

type FolderRead =
  | { read: "home" }
  | { read: "children"; directory: string }
  | { read: "search"; directory: string; query: string; limit: number }

function folderRead(body: unknown): FolderRead | undefined {
  const read = nonBlankField(body, "read")
  if (read === "home") return { read }
  const directory = nonBlankField(body, "directory")
  if (!directory) return undefined
  if (read === "children") return { read, directory }
  if (read !== "search") return undefined
  const limit = readFiniteNumber(body, "limit")
  const query = readString(body, "query") ?? ""
  return { read, directory, query, limit: limit !== undefined && Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAX_SEARCH_RESULTS) : 50 }
}

async function answerFolderRead(c: Context, request: FolderRead) {
  if (request.read === "home") return c.json({ home: os.homedir() })
  try {
    if (request.read === "children") {
      const entries = await directoryEntries(request.directory, request.directory)
      return c.json({ folders: entries.filter((entry) => entry.type === "directory").map(({ name, absolute }) => ({ name, absolute })) })
    }
    if (!(await fs.stat(request.directory)).isDirectory()) return answerRefusal(c, folderFailure({ code: "ENOTDIR" }, request.directory))
    return c.json({ folders: await searchFolders(request.directory, request.query, request.limit) })
  } catch (error) {
    return answerRefusal(c, folderFailure(error, request.directory))
  }
}

type CloneRequest = { repoUrl: string; directory: string; broker?: { url: string; authorization: string } }

function cloneRequest(body: unknown): CloneRequest | undefined {
  const repoUrl = nonBlankField(body, "repoUrl")
  const directory = nonBlankField(body, "directory")
  if (!repoUrl || !directory || !path.isAbsolute(directory)) return undefined
  if (readField(body, "broker") === undefined) return { repoUrl, directory }
  const broker = readRecord(body, "broker")
  const url = nonBlankField(broker, "url")
  const authorization = nonBlankField(broker, "authorization")
  return url && authorization ? { repoUrl, directory, broker: { url, authorization } } : undefined
}

async function cloneOutcome(request: CloneRequest): Promise<{ answer: Record<string, unknown> } | { refusal: Refusal }> {
  await fs.mkdir(path.dirname(request.directory), { recursive: true })
  try {
    await fs.mkdir(request.directory)
  } catch (error) {
    if (readString(error, "code") !== "EEXIST") throw error
    return { refusal: { status: 409, code: "folder_exists", message: `${request.directory} already exists on this machine` } }
  }
  const credential = request.broker && { broker: request.broker.url, repoUrl: request.repoUrl, authorization: request.broker.authorization }
  try {
    await cloneInto(request.repoUrl, request.directory, credential)
  } catch (error) {
    if (error instanceof RepositoryCloneError) return { refusal: { status: 502, code: "repository_clone_failed", message: error.message } }
    throw error
  }
  return { answer: { directory: request.directory } }
}

type WorktreeRequest = { repository: string; project: string; name?: string; baseRef?: string }

const PROJECT_ID = /^[A-Za-z0-9_-]{1,128}$/

function worktreeRequest(body: unknown): WorktreeRequest | undefined {
  const repository = nonBlankField(body, "repository")
  const project = nonBlankField(body, "project")
  if (!repository || !path.isAbsolute(repository) || !project || !PROJECT_ID.test(project)) return undefined
  const name = nonBlankField(body, "name")
  const baseRef = nonBlankField(body, "baseRef")
  if ((readField(body, "name") !== undefined && !name) || (readField(body, "baseRef") !== undefined && !baseRef)) return undefined
  return { repository, project, ...(name ? { name } : {}), ...(baseRef ? { baseRef } : {}) }
}

async function worktreeOutcome(request: WorktreeRequest): Promise<{ answer: Record<string, unknown> } | { refusal: Refusal }> {
  if (!(await fs.stat(request.repository).then((stat) => stat.isDirectory(), () => false))) {
    return { refusal: { status: 404, code: "folder_not_found", message: `${request.repository} is not a folder on this machine` } }
  }
  try {
    const info = await nextWorktreeInfo(request.repository, request.project, request.name)
    if (!info) return { refusal: { status: 409, code: "worktree_name_taken", message: "No free name for a new worktree of that folder" } }
    const checkout = await resolveWorktreeCheckout(request.repository, { kind: "branch", branch: info.branch, ...(request.baseRef ? { baseRef: request.baseRef } : {}) })
    await addGitWorktree(request.repository, info.directory, checkout)
    return { answer: { directory: info.directory, branch: info.branch, name: info.name } }
  } catch (error) {
    if (error instanceof WorktreeProvisionError) return { refusal: { status: 400, code: "worktree_create_failed", message: error.detail || error.message } }
    throw error
  }
}

/** How often a long answer sends a blank while its outcome is still to come. */
const LONG_ANSWER_BEAT_MS = 10_000

/**
 * The answer to an operation that outlasts the relay's 30 s wait for a
 * response to start: it starts at once with 200 and a blank, carries one
 * blank per beat, and ends with its outcome as the body's one JSON value,
 * the answer itself or `{ error: { code, message, status } }`. JSON allows
 * the blanks before it.
 */
function answerWhenDone(work: () => Promise<{ answer: Record<string, unknown> } | { refusal: Refusal }>): Response {
  const encoder = new TextEncoder()
  let beat: ReturnType<typeof setInterval> | undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(" "))
      beat = setInterval(() => controller.enqueue(encoder.encode(" ")), LONG_ANSWER_BEAT_MS)
      void work()
        .catch((error: unknown) => ({ refusal: { status: 502 as const, code: "host_management_failed", message: error instanceof Error ? error.message : String(error) } }))
        .then((outcome) => {
          clearInterval(beat)
          const value = "answer" in outcome ? outcome.answer : { error: { code: outcome.refusal.code, message: outcome.refusal.message, status: outcome.refusal.status } }
          controller.enqueue(encoder.encode(JSON.stringify(value)))
          controller.close()
        })
    },
    cancel() {
      clearInterval(beat)
    },
  })
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } })
}

/**
 * The machine-wide operations a connected machine answers for its owner,
 * reached through any workspace it serves: the relay's proof says who asks,
 * and the control plane's grant says this person owns this machine and asked
 * for this operation at this destination. Each grant is spent once.
 */
export function createHostManagement(options: HostManagementOptions): HostManagement {
  const admit = createAdmission(options, options.controlPlaneKeys)
  const routes = new Hono<Env>().post(HOST_MANAGEMENT_ROUTES["folders.read"], async (c) => {
    const request = folderRead(await c.req.json().catch(() => undefined))
    if (!request) return answerRefusal(c, { status: 400, code: "host_management_request_invalid", message: "Name what to read: home, children or search, and the folder" })
    const refusal = await admit(c, "folders.read", request.read === "home" ? "~" : request.directory)
    if (refusal) return answerRefusal(c, refusal)
    return await answerFolderRead(c, request)
  }).post(HOST_MANAGEMENT_ROUTES.clone, async (c) => {
    const request = cloneRequest(await c.req.json().catch(() => undefined))
    if (!request) return answerRefusal(c, { status: 400, code: "host_management_request_invalid", message: "Name the repository and the full path of the folder it is cloned into" })
    const refusal = await admit(c, "clone", request.directory)
    if (refusal) return answerRefusal(c, refusal)
    return answerWhenDone(() => cloneOutcome(request))
  }).post(HOST_MANAGEMENT_ROUTES.worktree, async (c) => {
    const request = worktreeRequest(await c.req.json().catch(() => undefined))
    if (!request) return answerRefusal(c, { status: 400, code: "host_management_request_invalid", message: "Name the folder's full path and its project, with an optional name and base" })
    const refusal = await admit(c, "worktree", request.repository)
    if (refusal) return answerRefusal(c, refusal)
    return answerWhenDone(() => worktreeOutcome(request))
  })
  return {
    contribution: {
      id: "host-management",
      mount: () => ({ path: "/", routes: new Hono().route("/", routes), dispose: () => {} }),
    },
  }
}

/** The key set a control plane at `controlPlaneUrl` signs its grants under. */
export function controlPlaneKeySet(controlPlaneUrl: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(`${controlPlaneUrl.replace(/\/+$/, "")}/.well-known/jwks.json`))
}
