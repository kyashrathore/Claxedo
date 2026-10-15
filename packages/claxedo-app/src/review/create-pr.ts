import { createMemo, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useServer, type GitStatus, type PlacementId } from "@/server"
import { useReviewApi } from "./api"

const GITHUB_HOST = /(^|[@/.])github\.com[:/]/
const ORIGIN_BRANCH = /^origin\/(.+)$/

function githubOwnerRepo(remote: string | undefined): string | undefined {
  if (!remote || !GITHUB_HOST.test(remote)) return undefined
  return remote.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1]
}

function pushedBranch(status: GitStatus): string | undefined {
  if (status.ahead > 0) return undefined
  return status.upstream?.match(ORIGIN_BRANCH)?.[1]
}

export function pullRequestCompareUrl(input: { readonly remote?: string; readonly defaultRef?: string; readonly status: GitStatus }): string | undefined {
  const ownerRepo = githubOwnerRepo(input.remote)
  const head = pushedBranch(input.status)
  const base = input.defaultRef?.replace(ORIGIN_BRANCH, "$1")
  if (!ownerRepo || !head || !base || head === base) return undefined
  return `https://github.com/${ownerRepo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?expand=1`
}

export function useCompareUrl(placementId: Accessor<PlacementId>, status: Accessor<GitStatus>): Accessor<string | undefined> {
  const server = useServer()
  const api = useReviewApi()
  const bases = useQuery(() => api.bases(placementId()))
  return createMemo(() =>
    pullRequestCompareUrl({ remote: server.placements.byId(placementId())?.gitRemote, defaultRef: bases.data?.defaultRef, status: status() }),
  )
}
