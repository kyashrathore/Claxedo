import { cleanup, render } from "@solidjs/testing-library"
import { QueryClientProvider, skipToken } from "@tanstack/solid-query"
import { afterEach, describe, expect, test, vi } from "vitest"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"
import { queryKeys } from "@/platform/query/keys"

vi.mock("@/features/session/app-ports", () => ({
  useWorkspaceQuery: () => ({ data: undefined }),
}))

import { createSessionPaneQueries, sessionCapabilitiesKey } from "./session-pane-queries"

afterEach(() => {
  cleanup()
  queryClient.clear()
})

describe("session pane cache observers", () => {
  test("observe canonical session cache keys without installing fetch closures", () => {
    const Probe = () => {
      createSessionPaneQueries({
        active: () => true,
        sessionID: () => "ses_1",
        directory: () => "/repo",
      })
      return <div />
    }

    render(() => (
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>
    ))

    const keys = [
      shellDataKeys.sessionId("ses_1", "status"),
      shellDataKeys.sessionId("ses_1", "requests"),
      shellDataKeys.sessionId("ses_1", "todo"),
      shellDataKeys.sessionId("ses_1", "diff"),
      sessionCapabilitiesKey({ sessionID: "ses_1", directory: "/repo" }),
    ]
    for (const queryKey of keys) {
      expect(queryClient.getQueryCache().find({ queryKey })?.options.queryFn).toBe(skipToken)
    }
  })

  test("central session rows use their authoritative transport query", async () => {
    const fetchSessionRow = vi.fn(async () => ({ id: "ses_1" } as never))
    const Probe = () => {
      createSessionPaneQueries({
        active: () => true,
        sessionID: () => "ses_1",
        directory: () => "/repo",
        sessionRef: () => ({ sessionId: "ses_1", host: "central", toolSandbox: { kind: "virtual" } }),
        fetchSessionRow,
      })
      return <div />
    }

    render(() => (
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>
    ))

    await vi.waitFor(() => expect(fetchSessionRow).toHaveBeenCalledWith("ses_1"))
    await vi.waitFor(() => expect(
      queryClient.getQueryData(queryKeys.session.row(undefined, "/repo", "ses_1")),
    ).toEqual({ id: "ses_1" }))
  })
})
