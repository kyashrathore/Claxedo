import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { installCachedAgentExtension } from "./install"
import { getRuntimeAgentExtensionsSnapshot } from "./runtime-config"
import { mirrorWorkspaceAgentExtensionRecord, readMirroredWorkspaceAgentExtensions } from "./workspace"
import { applyRuntimeAgentExtensions } from "./replay"
import {
  FIRST_PARTY_AGENT_EXTENSION_ID,
  FIRST_PARTY_AGENT_EXTENSION_PACKAGE_NAME,
  FIRST_PARTY_AGENT_EXTENSIONS_DIR,
} from "./types"
import { readMaterializedRuntimeRecord } from "./materialization"

const root = path.join(os.tmpdir(), `agent-extensions-runtime-config-${randomUUID().slice(0, 8)}`)
const source = path.join(root, "source")
const project = path.join(root, "project")
const home = path.join(root, "home")
const data = path.join(root, "data")

function normalizeProjectPaths(input: unknown, projectDir: string) {
  return JSON.parse(JSON.stringify(input).replaceAll(projectDir, "<project>"))
}

describe("Agent Extensions runtime config projection", () => {
  beforeEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.mkdir(source, { recursive: true })
    await fs.mkdir(project, { recursive: true })
    await fs.mkdir(home, { recursive: true })
    await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\n")
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  test("projects enabled desired installs and lock identity without generated paths", async () => {
    const installed = await installCachedAgentExtension({
      sourceRoot: source,
      source: { type: "github", owner: "acme", repo: "review" },
      resolvedSha: "abcdef1234567890",
      scope: "project",
      projectDir: project,
      dataRoot: data,
      homeDir: home,
      targets: ["cursor"],
      id: "review",
      now: 100,
    })

    await expect(getRuntimeAgentExtensionsSnapshot({ projectDir: project })).resolves.toEqual({
      version: 1,
      installs: [{
        desired: {
          id: "review",
          package_name: path.basename(installed.cache.path),
          source: { type: "github", owner: "acme", repo: "review" },
          scope: "project",
          enabled: true,
          targets: ["cursor"],
          installed_at: 100,
          updated_at: 100,
        },
        lock: {
          source: { type: "github", owner: "acme", repo: "review" },
          resolved_sha: "abcdef1234567890",
          manifest_digests: { package: expect.any(String) },
          component_digests: { package: expect.any(String) },
          targets: ["cursor"],
        },
        status: "applied",
        effective: {
          enabled: true,
          source: "desired",
        },
        components: [{
          runner: "cursor",
          component: path.basename(installed.cache.path),
          type: "skill",
          status: "applied",
        }],
      }],
    })
  })

  test("projects machine scope installs from global state", async () => {
    const installed = await installCachedAgentExtension({
      sourceRoot: source,
      source: { type: "github", owner: "acme", repo: "review" },
      resolvedSha: "abcdef1234567890",
      scope: "machine",
      dataRoot: data,
      homeDir: home,
      targets: ["cursor"],
      id: "review",
      now: 100,
    })

    await expect(getRuntimeAgentExtensionsSnapshot({
      projectDir: project,
      scope: "machine",
      dataRoot: data,
    })).resolves.toMatchObject({
      version: 1,
      installs: [{
        desired: {
          id: "review",
          package_name: path.basename(installed.cache.path),
          scope: "machine",
          enabled: true,
          targets: ["cursor"],
          installed_at: 100,
          updated_at: 100,
        },
        lock: {
          source: { type: "github", owner: "acme", repo: "review" },
          resolved_sha: "abcdef1234567890",
          targets: ["cursor"],
        },
        status: "applied",
        effective: {
          enabled: true,
          source: "desired",
        },
        components: [{
          runner: "cursor",
          type: "skill",
          status: "applied",
        }],
      }],
    })

    await expect(getRuntimeAgentExtensionsSnapshot({ projectDir: project })).resolves.toEqual({
      version: 1,
      installs: [],
    })
  })

  test("discovers first-party project extensions from the fixed source directory", async () => {
    await fs.mkdir(path.join(project, FIRST_PARTY_AGENT_EXTENSIONS_DIR, "skills", "review"), { recursive: true })
    await fs.writeFile(path.join(project, FIRST_PARTY_AGENT_EXTENSIONS_DIR, "skills", "review", "SKILL.md"), "review skill")

    await expect(getRuntimeAgentExtensionsSnapshot({ projectDir: project })).resolves.toEqual({
      version: 1,
      installs: [{
        desired: {
          id: FIRST_PARTY_AGENT_EXTENSION_ID,
          package_name: FIRST_PARTY_AGENT_EXTENSION_PACKAGE_NAME,
          source: {
            type: "project",
            package_path: FIRST_PARTY_AGENT_EXTENSIONS_DIR,
          },
          scope: "project",
          enabled: true,
          targets: ["opencode", "claude", "codex", "cursor"],
          installed_at: 0,
          updated_at: 0,
        },
        effective: {
          enabled: true,
          source: "desired",
        },
        components: [],
      }],
    })
  })

  test("does not treat generated first-party runtime state as source when the directory is gone", async () => {
    await fs.mkdir(path.join(project, ".agent-extensions"), { recursive: true })
    await fs.writeFile(path.join(project, ".agent-extensions", "installed.json"), JSON.stringify({
      version: 1,
      installs: [{
        id: FIRST_PARTY_AGENT_EXTENSION_ID,
        package_name: FIRST_PARTY_AGENT_EXTENSION_PACKAGE_NAME,
        source: {
          type: "project",
          package_path: FIRST_PARTY_AGENT_EXTENSIONS_DIR,
        },
        scope: "project",
        enabled: true,
        targets: ["cursor"],
        installed_at: 0,
        updated_at: 0,
      }],
    }))

    await expect(getRuntimeAgentExtensionsSnapshot({ projectDir: project })).resolves.toEqual({
      version: 1,
      installs: [],
    })
  })

  test("includes Control Plane-hydrated workspace installs", async () => {
    await expect(getRuntimeAgentExtensionsSnapshot({ projectDir: project }, {
      workspaceInstalls: [{
        desired: {
          id: "control-plane-review",
          package_name: "control-plane-review",
          source: { type: "github", owner: "acme", repo: "control-plane-review" },
          scope: "workspace",
          enabled: true,
          targets: ["cursor"],
          installed_at: 10,
          updated_at: 20,
        },
        lock: {
          source: { type: "github", owner: "acme", repo: "control-plane-review" },
          resolved_sha: "fedcba9876543210",
          manifest_digests: { package: "digest" },
          component_digests: { package: "digest" },
          targets: ["cursor"],
        },
      }],
    })).resolves.toMatchObject({
      version: 1,
      installs: [{
        desired: {
          id: "control-plane-review",
          scope: "workspace",
          enabled: true,
        },
        lock: {
          resolved_sha: "fedcba9876543210",
        },
        effective: {
          enabled: true,
          source: "desired",
        },
        components: [],
      }],
    })
  })

  test("workspace mirror snapshots materialize like local installs through runtime replay", async () => {
    const localProject = path.join(root, "local-project")
    const workspaceProject = path.join(root, "workspace-project")
    await fs.mkdir(localProject, { recursive: true })
    await fs.mkdir(workspaceProject, { recursive: true })
    const sourceRecord = { type: "github" as const, owner: "acme", repo: "review" }
    const local = await installCachedAgentExtension({
      sourceRoot: source,
      source: sourceRecord,
      resolvedSha: "abcdef1234567890",
      scope: "project",
      projectDir: localProject,
      dataRoot: data,
      homeDir: home,
      targets: ["cursor"],
      id: "review",
      now: 100,
    })
    await mirrorWorkspaceAgentExtensionRecord({
      workspaceId: "ws-review",
      dataRoot: data,
      record: {
        desired: {
          id: "review",
          package_name: local.materialized.package_name,
          source: sourceRecord,
          scope: "workspace",
          enabled: true,
          targets: ["cursor"],
          installed_at: 100,
          updated_at: 100,
        },
        lock: {
          source: sourceRecord,
          resolved_sha: "abcdef1234567890",
          manifest_digests: { package: local.cache.checksum },
          component_digests: { package: local.cache.checksum },
          targets: ["cursor"],
        },
      },
    })

    await applyRuntimeAgentExtensions(await getRuntimeAgentExtensionsSnapshot({ projectDir: workspaceProject }, {
      workspaceInstalls: await readMirroredWorkspaceAgentExtensions({
        workspaceId: "ws-review",
        dataRoot: data,
      }),
    }), workspaceProject, {
      homeDir: home,
      packageRoots: { review: local.cache.path },
      now: 100,
    })

    const localRecord = await readMaterializedRuntimeRecord(path.join(localProject, ".agent-extensions", "materialized.json"))
    const workspaceRecord = await readMaterializedRuntimeRecord(path.join(workspaceProject, ".agent-extensions", "materialized.json"))
    expect(normalizeProjectPaths(workspaceRecord, workspaceProject)).toEqual(normalizeProjectPaths(localRecord, localProject))
  })

  test("uses Control Plane-hydrated workspace installs instead of the local mirror when provided", async () => {
    // `getRuntimeAgentExtensionsSnapshot` no longer threads
    // `workspaceId` through (it's recovered from the state files
    // it reads). Drop the extra option to match the live signature.
    await expect(getRuntimeAgentExtensionsSnapshot({ projectDir: project }, {
      workspaceInstalls: [{
        desired: {
          id: "control-plane-review",
          package_name: "control-plane-review",
          source: { type: "github", owner: "acme", repo: "control-plane-review" },
          scope: "workspace",
          enabled: true,
          targets: ["cursor"],
          installed_at: 10,
          updated_at: 20,
        },
        lock: {
          source: { type: "github", owner: "acme", repo: "control-plane-review" },
          resolved_sha: "fedcba9876543210",
          manifest_digests: { package: "digest" },
          component_digests: { package: "digest" },
          targets: ["cursor"],
        },
      }],
    })).resolves.toMatchObject({
      version: 1,
      installs: [{
        desired: {
          id: "control-plane-review",
          scope: "workspace",
          enabled: true,
        },
        lock: {
          resolved_sha: "fedcba9876543210",
        },
        effective: {
          enabled: true,
          source: "desired",
        },
        components: [],
      }],
    })
  })

  test("org disabled policy blocks workspace enable and excludes runtime install", async () => {
    await expect(getRuntimeAgentExtensionsSnapshot({ projectDir: project }, {
      workspaceInstalls: [{
        desired: {
          id: "review",
          package_name: "review",
          source: { type: "github", owner: "acme", repo: "review" },
          scope: "workspace",
          enabled: true,
          targets: ["cursor"],
          installed_at: 10,
          updated_at: 20,
        },
        lock: {
          source: { type: "github", owner: "acme", repo: "review" },
          resolved_sha: "fedcba9876543210",
          manifest_digests: { package: "digest" },
          component_digests: { package: "digest" },
          targets: ["cursor"],
        },
      }],
      policyOverrides: [
        { id: "review", scope: "org", enabled: false, reason: "org blocked" },
        { id: "review", scope: "workspace", enabled: true, reason: "workspace requested" },
      ],
    })).resolves.toEqual({
      version: 1,
      installs: [],
    })
  })

  test("user default applies when workspace has no override", async () => {
    await expect(getRuntimeAgentExtensionsSnapshot({ projectDir: project }, {
      workspaceInstalls: [{
        desired: {
          id: "review",
          package_name: "review",
          source: { type: "github", owner: "acme", repo: "review" },
          scope: "workspace",
          enabled: true,
          targets: ["cursor"],
          installed_at: 10,
          updated_at: 20,
        },
        lock: {
          source: { type: "github", owner: "acme", repo: "review" },
          resolved_sha: "fedcba9876543210",
          manifest_digests: { package: "digest" },
          component_digests: { package: "digest" },
          targets: ["cursor"],
        },
      }],
      policyOverrides: [
        { id: "review", scope: "user", enabled: true, reason: "user default" },
      ],
    })).resolves.toMatchObject({
      installs: [{
        desired: { id: "review" },
        effective: {
          enabled: true,
          source: "user",
          reason: "user default",
        },
      }],
    })
  })

  test("workspace disabled overrides user default when org allows it", async () => {
    await expect(getRuntimeAgentExtensionsSnapshot({ projectDir: project }, {
      workspaceInstalls: [{
        desired: {
          id: "review",
          package_name: "review",
          source: { type: "github", owner: "acme", repo: "review" },
          scope: "workspace",
          enabled: true,
          targets: ["cursor"],
          installed_at: 10,
          updated_at: 20,
        },
        lock: {
          source: { type: "github", owner: "acme", repo: "review" },
          resolved_sha: "fedcba9876543210",
          manifest_digests: { package: "digest" },
          component_digests: { package: "digest" },
          targets: ["cursor"],
        },
      }],
      policyOverrides: [
        { id: "review", scope: "org", enabled: true, reason: "org allows" },
        { id: "review", scope: "user", enabled: true, reason: "user default" },
        { id: "review", scope: "workspace", enabled: false, reason: "workspace disabled" },
      ],
    })).resolves.toEqual({
      version: 1,
      installs: [],
    })
  })
})
