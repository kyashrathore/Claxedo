import { createFlow, runFlow } from "@/lib/flow"
import { toAppError, type PlacementId } from "@/server"
import { useReviewApi } from "./api"

export type GitAction = "commit" | "push" | "stage" | "unstage"

export function createGitActions(placementId: () => PlacementId) {
  const api = useReviewApi()
  const flow = createFlow<GitAction, void>()
  const run = async (action: GitAction, work: () => Promise<unknown>) => {
    await runFlow(flow, action, async () => void (await work()), toAppError)
    return flow.state().kind === "done"
  }
  return {
    pending: (): GitAction | undefined => {
      const state = flow.state()
      return state.kind === "running" ? state.step : undefined
    },
    error: () => {
      const state = flow.state()
      return state.kind === "failed" ? state.error : undefined
    },
    stage: (paths: string[]) => void run("stage", () => api.stage(placementId(), paths)),
    unstage: (paths: string[]) => void run("unstage", () => api.unstage(placementId(), paths)),
    push: (setUpstream: boolean) => run("push", () => api.push(placementId(), setUpstream ? { setUpstream } : {})),
    commit: (message: string, amend: boolean) => run("commit", () => api.commit(placementId(), { message, amend })),
  }
}
