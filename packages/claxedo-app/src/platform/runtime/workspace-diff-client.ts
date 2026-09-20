import { createTransport } from "@/platform/runtime/transport"
import {
  centralTransportForServer,
  type WorkspaceRuntimeRequestOptions,
  type WorkspaceRuntimeSnapshotLike,
} from "@/platform/runtime/transport"
import { asRecord, readArray, readField, readFiniteNumber, readString, readStringArray } from "@/lib/record"

type RawVcsFileDiff = {
  file: string
  before?: string
  after?: string
  patch?: string
  additions: number
  deletions: number
  status?: string
}

function isRawVcsFileDiff(value: unknown): value is RawVcsFileDiff {
  return typeof readField(value, "file") === "string"
    && typeof readField(value, "additions") === "number"
    && typeof readField(value, "deletions") === "number"
}

export type VcsRefs = {
  branches: string[]
  /** Git-resolvable ref paired with the source branch name expected by cloud provisioning. */
  branchChoices?: { gitRef: string; sourceBranch?: string }[]
  tags: string[]
  recent: { hash: string; subject: string }[]
}

export type WorkspaceDiffClient = ReturnType<typeof createWorkspaceDiffClient>

type WorkspaceDiffResource = "vcs" | "vcs/file" | "refs" | "targets"

/**
 * A response body, unnarrowed.
 *
 * `Response.json()` is typed `Promise<any>`, so the previous `json<T>(res,
 * fallback)` helper let every call site NAME a shape and receive it back
 * unverified — four routes each claimed a different DTO and none of them
 * checked one. Widening to `unknown` here forces the readers below to state
 * what they actually looked at, which is also what the route already did for
 * diff rows via `isRawVcsFileDiff`.
 */
async function jsonBody(res: Response): Promise<unknown> {
  if (!res.ok) return undefined
  return await res.json().catch(() => undefined)
}

/**
 * A diff row for one file. `file` is the identity — a row without it is not a
 * row — and every other field is optional because the route omits them for
 * summary reads.
 */
function asVcsFileDiff(value: unknown): (Partial<RawVcsFileDiff> & { file: string }) | undefined {
  const row = asRecord(value)
  const file = readString(row, "file")
  if (file === undefined) return undefined
  const before = readString(row, "before")
  const after = readString(row, "after")
  const patch = readString(row, "patch")
  const status = readString(row, "status")
  const additions = readFiniteNumber(row, "additions")
  const deletions = readFiniteNumber(row, "deletions")
  return {
    file,
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
    ...(patch === undefined ? {} : { patch }),
    ...(status === undefined ? {} : { status }),
    ...(additions === undefined ? {} : { additions }),
    ...(deletions === undefined ? {} : { deletions }),
  }
}

/**
 * Git refs as this client models them. A malformed entry is dropped rather
 * than surfaced: the ref pickers render every element, so one bad row used to
 * mean an empty label in a list the user is asked to choose from.
 */
function asVcsRefs(value: unknown): VcsRefs {
  const row = asRecord(value)
  const rawChoices = readArray(row, "branchChoices")
  const branchChoices = (rawChoices ?? []).flatMap((item) => {
    const gitRef = readString(item, "gitRef")
    if (gitRef === undefined) return []
    const sourceBranch = readString(item, "sourceBranch")
    return [{ gitRef, ...(sourceBranch === undefined ? {} : { sourceBranch }) }]
  })
  const recent = (readArray(row, "recent") ?? []).flatMap((item) => {
    const hash = readString(item, "hash")
    const subject = readString(item, "subject")
    return hash === undefined || subject === undefined ? [] : [{ hash, subject }]
  })
  return {
    branches: readStringArray(row, "branches") ?? [],
    ...(rawChoices === undefined ? {} : { branchChoices }),
    tags: readStringArray(row, "tags") ?? [],
    recent,
  }
}

export function createWorkspaceDiffClient(options: WorkspaceRuntimeRequestOptions) {
  const transportFor = async (dir: string) => {
    const workspace = workspaceRuntimeSnapshot(options.workspace) ??
      workspaceRuntimeSnapshot(options.workspaceId ? { kind: "provisioner", workspaceId: options.workspaceId } : undefined) ??
      workspaceRuntimeSnapshot(await options.resolveWorkspaceRuntime?.({
        directory: dir,
        workspaceId: options.workspaceId,
      }))
    const serverTransport = centralTransportForServer(options.serverUrl)
    return createTransport({
      placement: workspace
        ? {
            workspaceId: workspace.workspaceId,
            hosting: "workspace",
            transport: serverTransport === "loopback" ? "loopback" : "workspace-relay",
          }
        : {
            hosting: "workspace",
            transport: serverTransport,
          },
      serverUrl: options.serverUrl,
      directory: dir,
      request: options.request,
      relayRequest: options.relayRequest,
    })
  }

  const fetch = async (dir: string, path: string) => (await transportFor(dir)).fetch(path)

  const refsResponse = async (scope: string) => {
    const res = await fetch(scope, workspaceDiffPath({
      resource: "refs",
      query: { directory: scope },
    }))
    if (!res.ok) throw new Error(`Failed to load Git refs: ${res.status}`)
    return asVcsRefs(await res.json())
  }

  return {
    async vcs(input: {
      directory: string
      mode: string
      fromRef?: string
      toRef?: string
      content?: "full" | "summary"
    }) {
      const res = await fetch(input.directory, workspaceDiffPath({
        resource: "vcs",
        query: input,
      }))
      const data = await jsonBody(res)
      // The route answers with diff rows; a row without a file path is not one.
      return Array.isArray(data) ? data.filter(isRawVcsFileDiff) : []
    },

    async vcsFile(input: {
      directory: string
      mode: string
      file: string
      fromRef?: string
      toRef?: string
    }) {
      const res = await fetch(input.directory, workspaceDiffPath({
        resource: "vcs/file",
        query: input,
      }))
      return asVcsFileDiff(await jsonBody(res))
    },

    async refs(directory: string) {
      return await refsResponse(directory).catch(() => ({ branches: [], tags: [], recent: [] }))
    },

    /** Strict refs read for controls that must distinguish loading failure from an empty repository. */
    async refsRequired(scope: string) {
      return await refsResponse(scope)
    },

    async targets(directory: string) {
      const res = await fetch(directory, workspaceDiffPath({
        resource: "targets",
        query: { directory },
      }))
      const body = await jsonBody(res)
      const defaultRef = readString(body, "defaultRef")
      const candidates = readStringArray(body, "candidates")
      return {
        ...(defaultRef === undefined ? {} : { defaultRef }),
        ...(candidates === undefined ? {} : { candidates }),
      }
    },
  }
}

function workspaceRuntimeSnapshot(input: WorkspaceRuntimeSnapshotLike | undefined) {
  if (input?.kind && input.kind !== "self" && input.workspaceId) {
    return { workspaceId: input.workspaceId }
  }
  return undefined
}

function workspaceDiffPath(input: {
  resource: WorkspaceDiffResource
  query?: Record<string, string | undefined>
}) {
  const url = new URL(`/api/wr/diff/${input.resource}`, "http://claxedo.local")
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value)
  }
  return `${url.pathname}${url.search}`
}
