import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import {
  mirrorWorkspaceAgentExtensionRecord,
  readMirroredWorkspaceAgentExtensions,
  removeMirroredWorkspaceAgentExtension,
  resolveGitHubWorkspaceAgentExtension,
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

  test("derives marketplace package_name from the manifest like local installs do", async () => {
    // The name deliberately differs from the install id AND the source repo:
    // package_name must come from the manifest (installFetchedAgentExtension's
    // derivation), or workspace and machine/project installs of one source
    // materialize to different artifact paths.
    const fixture = path.join(root, "marketplace-fixture")
    await fs.mkdir(path.join(fixture, ".claude-plugin"), { recursive: true })
    await fs.mkdir(path.join(fixture, "skills", "pdf"), { recursive: true })
    await fs.writeFile(path.join(fixture, ".claude-plugin", "marketplace.json"), JSON.stringify({
      name: "acme-tools",
      plugins: [{ name: "pdf", path: "skills/pdf" }],
    }))
    await fs.writeFile(path.join(fixture, "skills", "pdf", "SKILL.md"), "---\nname: pdf\n---\n")
    const fetchPackage = async () => ({
      path: fixture,
      checksum: "checksum",
      resolvedSha: "abcdef1234567890",
    })

    const pinned = await resolveGitHubWorkspaceAgentExtension({
      source: "acme/tools",
      workspaceId: "ws_1",
      id: "acme-catalog-tools",
      dataRoot,
      now: 100,
      fetchPackage,
    })
    expect(pinned.id).toBe("acme-catalog-tools")
    expect(pinned.record.desired.package_name).toBe("acme-tools")

    const bare = await resolveGitHubWorkspaceAgentExtension({
      source: "acme/tools",
      workspaceId: "ws_1",
      dataRoot,
      now: 100,
      fetchPackage,
    })
    expect(bare.id).toBe("acme-tools")
    expect(bare.record.desired.package_name).toBe("acme-tools")
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

  test("mirror upsert absorbs the replaced legacy id from desired and lock state", async () => {
    await mirrorWorkspaceAgentExtensionRecord({
      workspaceId: "ws_1",
      dataRoot,
      record,
    })

    const pinned = {
      desired: {
        ...record.desired,
        id: "acme-catalog-review",
        updated_at: 200,
      },
      lock: {
        ...record.lock,
        resolved_sha: "fedcba9876543210",
      },
    }
    await mirrorWorkspaceAgentExtensionRecord({
      workspaceId: "ws_1",
      dataRoot,
      record: pinned,
      replaces: "review",
    })

    await expect(readMirroredWorkspaceAgentExtensions({
      workspaceId: "ws_1",
      dataRoot,
    })).resolves.toEqual([pinned])
  })
})
