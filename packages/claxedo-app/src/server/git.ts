import type { QueryClient } from "@tanstack/solid-query"
import { ServerError } from "./errors"
import { fetchQuery } from "./fetch-query"
import type { GitApi } from "./api"
import type { PlacementId } from "./ids"
import { queryKeys } from "./query-keys"
import { jsonInit, withQuery, type Transport } from "./transport"
import type { DiffFile, DiffScope, DiffSummary, GitBases, GitCommit, GitRefs, GitStatus } from "./git-types"
import type { FetchQuery } from "./types"
import type { Workspaces } from "./workspaces"
import {
  diffFileFromWire,
  diffFilesFromWire,
  diffQuery,
  gitBasesFromWire,
  gitCommitHashFromWire,
  gitCommitsFromWire,
  gitPushResultFromWire,
  gitRefsFromWire,
  gitStatusFromWire,
} from "./wire/git"

const GIT_PATH = "/api/wr/git"
const DIFF_PATH = "/api/wr/diff"

export function gitQueries(transport: Transport, workspaces: Workspaces) {
  const server = transport.serverUrl
  const read = async (placementId: PlacementId, path: string) => transport.runtimeJson(await workspaces.route(placementId), path)
  const status = (placementId: PlacementId): FetchQuery<GitStatus> => fetchQuery(queryKeys.gitStatus(server, placementId), async () => gitStatusFromWire(await read(placementId, `${GIT_PATH}/status`)))
  const log = (placementId: PlacementId, limit: number): FetchQuery<readonly GitCommit[]> => fetchQuery(queryKeys.gitLog(server, placementId, limit), async () => gitCommitsFromWire(await read(placementId, withQuery(`${GIT_PATH}/log`, { limit }))))
  const refsQuery = (placementId: PlacementId): FetchQuery<GitRefs> => fetchQuery(queryKeys.gitRefs(server, placementId), async () => gitRefsFromWire(await read(placementId, `${DIFF_PATH}/refs`)))
  const bases = (placementId: PlacementId): FetchQuery<GitBases> => fetchQuery(queryKeys.gitBases(server, placementId), async () => gitBasesFromWire(await read(placementId, `${DIFF_PATH}/targets`)))
  const diff = (placementId: PlacementId, scope: DiffScope): FetchQuery<readonly DiffSummary[]> => fetchQuery(queryKeys.gitDiff(server, placementId, scope), async () =>
      diffFilesFromWire(await read(placementId, withQuery(`${DIFF_PATH}/vcs`, { ...diffQuery(scope), content: "summary" }))),
    )
  const diffFileQuery = (placementId: PlacementId, scope: DiffScope, file: string): FetchQuery<DiffFile> => fetchQuery(queryKeys.gitDiffFile(server, placementId, scope, file), async () => {
      const entry = diffFileFromWire(await read(placementId, withQuery(`${DIFF_PATH}/vcs/file`, { ...diffQuery(scope), file, content: "full" })))
      if (!entry) throw new ServerError({ class: "not_found", message: `No diff for ${file}` })
      return entry
    })
  return { status, log, refs: refsQuery, bases, diff, diffFile: diffFileQuery }
}

export function createGitApi(transport: Transport, workspaces: Workspaces, queryClient: QueryClient): GitApi {
  const post = async (placementId: PlacementId, path: string, body: unknown) => {
    const answer = await transport.runtimeJson(await workspaces.route(placementId), `${GIT_PATH}${path}`, jsonInit("POST", body))
    await queryClient.invalidateQueries({ queryKey: queryKeys.gitOf(transport.serverUrl, placementId) })
    return answer
  }
  return {
    stage: async (placementId, paths) => {
      await post(placementId, "/stage", { paths })
    },
    unstage: async (placementId, paths) => {
      await post(placementId, "/unstage", { paths })
    },
    commit: async (placementId, input) => ({ hash: gitCommitHashFromWire(await post(placementId, "/commit-staged", input)) }),
    push: async (placementId, input) => gitPushResultFromWire(await post(placementId, "/push", input)),
  }
}
