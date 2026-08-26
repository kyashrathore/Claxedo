import { describe, expect, test } from "bun:test"
import { workspaceFileStatusQueryOptions } from "./workspace-file-status-query"

describe("workspace file-status query identity", () => {
  test("isolates workspace-bound clients that share a server URL and directory", () => {
    const client = { file: { status: async () => ({ data: [] }) } }
    const first = workspaceFileStatusQueryOptions({
      baseUrl: "https://server.test",
      directoryPath: "/workspace",
      workspaceKey: "workspace-a",
      client,
    })
    const second = workspaceFileStatusQueryOptions({
      baseUrl: "https://server.test",
      directoryPath: "/workspace",
      workspaceKey: "workspace-b",
      client,
    })
    expect(first.queryKey).not.toEqual(second.queryKey)
  })
})
