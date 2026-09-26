import { createMemo, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useServer, type PlacementId } from "@/server"
import { useReviewApi } from "./api"

const GITHUB_HOST = /(^|[@/.])github\.com[:/]/

function githubOwnerRepo(remote: string | undefined): string | undefined {
  if (!remote || !GITHUB_HOST.test(remote)) return undefined
  return remote.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1]
}

export function useCompareUrl(placementId: Accessor<PlacementId>, branch: Accessor<string | undefined>): Accessor<string | undefined> {
  const server = useServer()
  const api = useReviewApi()
  const bases = useQuery(() => api.bases(placementId()))
  return createMemo(() => {
    const ownerRepo = githubOwnerRepo(server.placements.byId(placementId())?.gitRemote)
    const head = branch()
    const base = bases.data?.defaultRef?.replace(/^origin\//, "")
    if (!ownerRepo || !head || !base || head === base) return undefined
    return `https://github.com/${ownerRepo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?expand=1`
  })
}
