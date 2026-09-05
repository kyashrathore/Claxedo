import { afterEach, describe, expect, test } from "bun:test"
import {
  configureWorkspaceCreateAuthority,
  createHostedWorkspace,
} from "./workspace-create-authority"

afterEach(() => configureWorkspaceCreateAuthority(undefined))

describe("workspace create authority", () => {
  test("fails closed when no signed account authority is bound", () => {
    expect(() => createHostedWorkspace({ projectId: "project-1" })).toThrow(
      "Hosted workspace creation requires a signed account authority",
    )
  })

  test("delegates the complete source to the credential-owning authority", async () => {
    const calls: unknown[] = []
    configureWorkspaceCreateAuthority(async (input) => {
      calls.push(input)
      return { workspaceId: "ws_1", directory: "/workspace" }
    })

    await expect(createHostedWorkspace({
      projectName: "plugin-catalog",
      workspaceName: "main",
      connectionId: "connection-1",
      repo: { fullName: "kyashrathore/plugins" },
      gitBranch: "main",
    })).resolves.toEqual({ workspaceId: "ws_1", directory: "/workspace" })
    expect(calls).toEqual([{
      projectName: "plugin-catalog",
      workspaceName: "main",
      connectionId: "connection-1",
      repo: { fullName: "kyashrathore/plugins" },
      gitBranch: "main",
    }])
  })
})
