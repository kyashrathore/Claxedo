import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import {
  mirrorWorkspaceAgentExtensionRecord,
  readMirroredWorkspaceAgentExtensions,
  removeMirroredWorkspaceAgentExtension,
  setMirroredWorkspaceAgentExtensionEnabled,
  workspaceAgentExtensionRecords,
} from "./workspace"

const root = path.join(os.tmpdir(), `agent-extensions-workspace-${randomUUID().slice(0, 8)}`)
const dataRoot = path.join(root, "data")

const record = {
  desired: {
    id: "review",
    package_name: "review",
    source: { type: "github" as const, owner: "acme", repo: "review" },
    scope: "workspace" as const,
    enabled: true,
    targets: ["cursor" as const],
    installed_at: 100,
    updated_at: 100,
  },
  lock: {
    source: { type: "github" as const, owner: "acme", repo: "review" },
    resolved_sha: "abcdef1234567890",
    manifest_digests: { package: "digest" },
    component_digests: { package: "digest" },
    targets: ["cursor" as const],
  },
}

describe("workspace Agent Extension state helpers", () => {
  beforeEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.mkdir(root, { recursive: true })
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  test("filters malformed workspace records", () => {
    expect(workspaceAgentExtensionRecords([
      record,
      { desired: { id: "missing-shape" } },
      { lock: record.lock },
      null,
    ])).toEqual([record])
  })

  test("mirrors, toggles, and removes workspace desired and lock state", async () => {
    await mirrorWorkspaceAgentExtensionRecord({
      workspaceId: "ws_1",
      dataRoot,
      record,
    })

    await expect(readMirroredWorkspaceAgentExtensions({
      workspaceId: "ws_1",
      dataRoot,
    })).resolves.toEqual([record])

    await setMirroredWorkspaceAgentExtensionEnabled({
      workspaceId: "ws_1",
      dataRoot,
      id: "review",
      enabled: false,
      now: 200,
    })

    await expect(readMirroredWorkspaceAgentExtensions({
      workspaceId: "ws_1",
      dataRoot,
    })).resolves.toMatchObject([{
      desired: {
        id: "review",
        enabled: false,
        updated_at: 200,
      },
      lock: {
        resolved_sha: "abcdef1234567890",
      },
    }])

    await removeMirroredWorkspaceAgentExtension({
      workspaceId: "ws_1",
      dataRoot,
      id: "review",
    })

    await expect(readMirroredWorkspaceAgentExtensions({
      workspaceId: "ws_1",
      dataRoot,
    })).resolves.toEqual([])
  })
})
