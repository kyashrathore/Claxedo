import { afterEach, describe, expect, test } from "bun:test"

import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { cachedSignedWorkspace } from "./cached-signed-workspace"

const server = "https://cp.test"

afterEach(() => {
  queryClient.removeQueries({ queryKey: queryKeys.controlPlane.projects(server) })
})

describe("cachedSignedWorkspace", () => {
  test("answers the inventory's workspace for a filesystem-path directory, from the shared cache", () => {
    queryClient.setQueryData(queryKeys.controlPlane.projects(server), [
      {
        id: "prj_1",
        worktree: "/Users/me/test/opencode",
        workspaces: {
          "/Users/me/test/opencode": { id: "ws_1", directory: "/Users/me/test/opencode", kind: "user-hosted", access: "user-hosted" },
        },
      },
    ])
    expect(cachedSignedWorkspace(server, "/Users/me/test/opencode")).toMatchObject({ workspaceId: "ws_1" })
    expect(cachedSignedWorkspace(server, "/somewhere/else")).toBeUndefined()
  })

  test("answers undefined before the inventory has loaded", () => {
    expect(cachedSignedWorkspace(server, "/Users/me/test/opencode")).toBeUndefined()
  })
})
