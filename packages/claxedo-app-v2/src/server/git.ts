import { ServerError } from "./errors"
import { fetchQuery } from "./fetch-query"
import type { GitApi } from "./api"
import type { PlacementId } from "./ids"
import { queryKeys } from "./query-keys"
import { jsonInit, withQuery, type Transport } from "./transport"
import type { DiffFile, DiffScope, DiffStatus, DiffSummary, GitBases, GitCommit, GitRefs, GitStatus } from "./git-types"
import type { FetchQuery } from "./types"
import type { Workspaces } from "./workspaces"

const GIT_PATH = "/api/wr/git"
const DIFF_PATH = "/api/wr/diff"

function diffQuery(scope: DiffScope): Record<string, string> {
  switch (scope.kind) {
    case "uncommitted":
    case "staged":
    case "unstaged":
      return { mode: scope.kind }
    case "branch":
      return { mode: "branch", fromRef: scope.base }
    case "branchWorktree":
      return { mode: "branch-worktree", fromRef: scope.base }
    case "range":
      return { mode: "to-from", fromRef: scope.from, toRef: scope.to }
  }
}

function diffStatus(value: unknown): DiffStatus | undefined {
  if (value === "added" || value === "A") return "added"
  if (value === "deleted" || value === "D") return "deleted"
  if (typeof value === "string") return "modified"
  return undefined
}

function diffFile(value: unknown): DiffFile | undefined {
  const row = value as Record<string, unknown> | null
  if (!row || typeof row.file !== "string") return undefined
  const status = diffStatus(row.status)
  return {
    file: row.file,
    ...(status ? { status } : {}),
    additions: typeof row.additions === "number" ? row.additions : 0,
    deletions: typeof row.deletions === "number" ? row.deletions : 0,
    ...(typeof row.from === "string" ? { from: row.from } : {}),
    ...(typeof row.patch === "string" ? { patch: row.patch } : {}),
    ...(typeof row.before === "string" ? { before: row.before } : {}),
    ...(typeof row.after === "string" ? { after: row.after } : {}),
  }
}

function refs(value: unknown): GitRefs {
  const row = value as Record<string, unknown> | null
  const strings = (input: unknown) => (Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : [])
  const recent = Array.isArray(row?.recent) ? row.recent : []
  return {
    branches: strings(row?.branches),
    tags: strings(row?.tags),
    recent: recent.flatMap((item) => {
      const entry = item as { hash?: unknown; subject?: unknown } | null
      return entry && typeof entry.hash === "string" && typeof entry.subject === "string" ? [{ hash: entry.hash, subject: entry.subject }] : []
    }),
  }
}

export function gitQueries(transport: Transport, workspaces: Workspaces) {
  const server = transport.serverUrl
  const read = async <T>(placementId: PlacementId, path: string) => transport.runtimeJson<T>(await workspaces.route(placementId), path)
  const status = (placementId: PlacementId): FetchQuery<GitStatus> => fetchQuery(queryKeys.gitStatus(server, placementId), () => read<GitStatus>(placementId, `${GIT_PATH}/status`))
  const log = (placementId: PlacementId, limit: number): FetchQuery<readonly GitCommit[]> => fetchQuery(queryKeys.gitLog(server, placementId, limit), async () => {
      const body = await read<{ commits?: unknown }>(placementId, withQuery(`${GIT_PATH}/log`, { limit }))
      return (Array.isArray(body.commits) ? body.commits : []) as readonly GitCommit[]
    })
  const refsQuery = (placementId: PlacementId): FetchQuery<GitRefs> => fetchQuery(queryKeys.gitRefs(server, placementId), async () => refs(await read<unknown>(placementId, `${DIFF_PATH}/refs`)))
  const bases = (placementId: PlacementId): FetchQuery<GitBases> => fetchQuery(queryKeys.gitBases(server, placementId), async () => {
      const body = await read<{ defaultRef?: unknown; candidates?: unknown }>(placementId, `${DIFF_PATH}/targets`)
      return {
        ...(typeof body.defaultRef === "string" ? { defaultRef: body.defaultRef } : {}),
        candidates: Array.isArray(body.candidates) ? body.candidates.filter((item): item is string => typeof item === "string") : [],
      }
    })
  const diff = (placementId: PlacementId, scope: DiffScope): FetchQuery<readonly DiffSummary[]> => fetchQuery(queryKeys.gitDiff(server, placementId, scope), async () => {
      const rows = await read<unknown[]>(placementId, withQuery(`${DIFF_PATH}/vcs`, { ...diffQuery(scope), content: "summary" }))
      return rows.flatMap((row) => {
        const entry = diffFile(row)
        return entry ? [entry] : []
      })
    })
  const diffFileQuery = (placementId: PlacementId, scope: DiffScope, file: string): FetchQuery<DiffFile> => fetchQuery(queryKeys.gitDiffFile(server, placementId, scope, file), async () => {
      const entry = diffFile(await read<unknown>(placementId, withQuery(`${DIFF_PATH}/vcs/file`, { ...diffQuery(scope), file, content: "full" })))
      if (!entry) throw new ServerError({ class: "not_found", message: `No diff for ${file}` })
      return entry
    })
  return { status, log, refs: refsQuery, bases, diff, diffFile: diffFileQuery }
}

export function createGitApi(transport: Transport, workspaces: Workspaces): GitApi {
  const post = async <T>(placementId: PlacementId, path: string, body: unknown) =>
    transport.runtimeJson<T>(await workspaces.route(placementId), `${GIT_PATH}${path}`, jsonInit("POST", body))
  return {
    stage: async (placementId, paths) => {
      await post<unknown>(placementId, "/stage", { paths })
    },
    unstage: async (placementId, paths) => {
      await post<unknown>(placementId, "/unstage", { paths })
    },
    commit: async (placementId, input) => {
      const body = await post<{ commit?: unknown }>(placementId, "/commit-staged", input)
      if (typeof body.commit !== "string") throw new ServerError({ class: "internal", message: "The commit answered without a commit hash" })
      return { hash: body.commit }
    },
    push: (placementId, input) => post(placementId, "/push", input),
  }
}
