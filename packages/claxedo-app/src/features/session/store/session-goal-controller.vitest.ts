import { afterEach, describe, expect, test, vi } from "vitest"
import { createRoot } from "solid-js"
import { queryClient } from "@/platform/query/query-client"
import type { SessionGoalData } from "./session-goal-query"

const harness = vi.hoisted(() => ({
  pending: [] as Array<{
    url: string
    method: string
    resolve: (response: Response) => void
  }>,
}))

vi.mock("@/platform/api/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/platform/api/api")>()
  return {
    ...original,
    authFetch: (input: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve) => {
      harness.pending.push({
        url: input instanceof Request ? input.url : String(input),
        method: init?.method ?? (input instanceof Request ? input.method : "GET"),
        resolve,
      })
    }),
    apiBearerToken: async () => null,
  }
})

import { createSessionGoalController } from "./session-goal-controller"
import { invalidateSessionGoalData, sessionGoalKey } from "./session-goal-query"
import { sessionResourceAuthorityScope } from "./session-resource-authority"

const serverUrl = "http://127.0.0.1:3001"
const scope = sessionResourceAuthorityScope({
  sessionID: "ses_1",
  directory: "/repo/main",
  serverUrl,
  signedControlPlane: false,
})

const capabilities = {
  implemented: true,
  available: true,
  actions: ["pause", "resume", "delete"] as const,
  recovery: "reconcile" as const,
  optionalFields: [] as const,
}

const activeGoal = {
  sessionId: "ses_1",
  objective: "Ship verified work",
  status: "active" as const,
  createdAt: 10,
  updatedAt: 20,
}

const mounted: Array<() => void> = []

function mountController() {
  let dispose = () => {}
  const controller = createRoot((disposeRoot) => {
    dispose = disposeRoot
    return createSessionGoalController({
      active: () => true,
      sessionID: () => "ses_1",
      directory: () => "/repo/main",
      client: {} as never,
      serverUrl: () => serverUrl,
      source: () => queryClient.getQueryData<SessionGoalData>(sessionGoalKey(scope)),
      suppressed: () => false,
    })
  })
  mounted.push(dispose)
  return { controller, dispose }
}

async function answerGoalRead(goal: typeof activeGoal | null) {
  await vi.waitFor(() => expect(harness.pending.length).toBeGreaterThan(0))
  harness.pending
    .find((item) => item.url.includes("/goal/state") && item.method === "GET")
    ?.resolve(Response.json({ capabilities, goal }))
}

afterEach(() => {
  // Dispose every mounted root even when an assertion threw first, or a leaked
  // invalidation subscriber would fire inside the next test.
  while (mounted.length) mounted.pop()?.()
  queryClient.clear()
  harness.pending.length = 0
  vi.restoreAllMocks()
})

describe("session Goal controller", () => {
  test("a cached Goal short-circuits the read until it is invalidated", async () => {
    queryClient.setQueryData<SessionGoalData>(sessionGoalKey(scope), { capabilities, goal: activeGoal })
    const { controller, dispose } = mountController()

    await expect(controller.sync("ses_1")).resolves.toBe(true)
    expect(harness.pending).toHaveLength(0)

    // The replay-gap path invalidates the authority; the mounted controller must
    // turn that into a real refetch, not a no-op on a skipToken mirror.
    await invalidateSessionGoalData(scope)
    await answerGoalRead({ ...activeGoal, status: "completed", updatedAt: 40 })

    await vi.waitFor(() => expect(
      queryClient.getQueryData<SessionGoalData>(sessionGoalKey(scope))?.goal,
    ).toMatchObject({ status: "completed", updatedAt: 40 }))
    dispose()
  })

  test("an invalidated entry is re-read on the next sync even after the controller unmounts", async () => {
    queryClient.setQueryData<SessionGoalData>(sessionGoalKey(scope), { capabilities, goal: activeGoal })
    const first = mountController()
    first.dispose()

    await invalidateSessionGoalData(scope)
    expect(harness.pending).toHaveLength(0)

    const { controller, dispose } = mountController()
    const sync = controller.sync("ses_1")
    await answerGoalRead(null)

    await expect(sync).resolves.toBe(true)
    expect(queryClient.getQueryData<SessionGoalData>(sessionGoalKey(scope))?.goal).toBeNull()
    dispose()
  })
})
