/**
 * Sandbox provisioning × agent-extensions integration test (W4).
 *
 * The in-sandbox workspace-runtime already replays `agent_extensions` from
 * every `POST /api/wr/config` push into its OWN filesystem
 * (workspace/runtime.ts → applyRuntimeAgentExtensions → materialize). The gap
 * this test pins down is the CONTROL-PLANE half: the snapshot pushed at
 * sandbox provisioning (`markSandboxReady` → `pushRuntimeConfig(state)`)
 * hydrated workspace installs through a hardcoded Convex authority, so on a
 * self-host deploy (SQLite authority) or an authority-less mount (local
 * mirror) the sandbox received snapshot metadata with an EMPTY install set —
 * and nothing ever materialized inside the sandbox.
 *
 * Covered here:
 *  1. a workspace extension declared in the LOCAL SQLite authority reaches the
 *     provisioning-time config push for a cloud workspace, and replaying that
 *     exact pushed body against a fake sandbox filesystem (temp dir, the same
 *     replay code the sandbox runs) materializes the skill where the harness
 *     expects it with status "applied";
 *  2. a workspace extension recorded only in the local MIRROR (authority-less
 *     mounts) also survives the provisioning push.
 */

import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { applyRuntimeAgentExtensions, digestDirectory } from "@claxedo/agent-extensions"
import type { SignedControlPlaneAuth } from "../../authority/auth"
import { createSqliteWorkspaceAuthority } from "../../authority/adapters/sqlite/workspace-authority"
import { pushRuntimeConfig } from "../../workspace/supervisor/config-sync"
import { __registerReadyRuntimeForTest, __unregisterRuntimeForTest } from "../../workspace/supervisor/test-helper"
import { mirrorWorkspaceAgentExtensionRecord } from "./workspace"

type RecordedRequest = { method: string; url: string; body: unknown }

type PushedSnapshot = {
  agent_extensions?: {
    version: 1
    installs: Array<{
      desired: { id: string; targets?: string[] }
      lock?: { resolved_sha?: string }
      effective: { enabled: boolean; source: string }
    }>
  }
}

async function startRecordingServer(): Promise<{ url: string; received: RecordedRequest[]; stop: () => Promise<void> }> {
  const received: RecordedRequest[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => {
      let body: unknown
      try {
        body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined
      } catch {
        body = undefined
      }
      received.push({ method: req.method ?? "", url: req.url ?? "", body })
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("failed to bind test recording server")
  return {
    url: `http://127.0.0.1:${address.port}`,
    received,
    stop: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  }
}

function signedAuth(subject: string): SignedControlPlaneAuth {
  return {
    mode: "signed",
    token: `tok_${subject}`,
    user: {
      subject,
      tokenIdentifier: `https://idp.example.test|${subject}`,
      issuer: "https://idp.example.test",
    },
  }
}

// `packageDigest` is the content hash of the package root this record's
// materialization will actually be handed. Recording it is REQUIRED for any
// record that reaches replay: materialization verifies the on-disk tree against
// `component_digests.package` and refuses to apply a package it cannot verify.
//
// This fixture used to pass empty digest maps with a comment noting that replay
// "skips checksum verification when no package digest is recorded". That
// fail-open was the vulnerability closed by the pre-launch security review
// (§6.15) — an unverifiable package is now a hard refusal, so a record without
// a digest no longer models a valid install. Records that never reach replay
// (push-path-only assertions) may still omit it.
function extensionRecord(id: string, packageDigest?: string) {
  const component_digests: Record<string, string> = packageDigest ? { package: packageDigest } : {}
  return {
    desired: {
      id,
      package_name: id,
      source: { type: "github" as const, owner: "acme", repo: id },
      scope: "workspace" as const,
      enabled: true,
      targets: ["claude" as const],
      installed_at: 0,
      updated_at: 0,
    },
    lock: {
      source: { type: "github" as const, owner: "acme", repo: id },
      resolved_sha: "cafebabecafebabecafebabecafebabecafebabe",
      manifest_digests: {},
      component_digests,
      targets: ["claude" as const],
    },
  }
}

async function writeSkillPackageFixture(root: string, skillName: string) {
  const skillDir = path.join(root, "skills", skillName)
  await fs.promises.mkdir(skillDir, { recursive: true })
  await fs.promises.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: probe skill for sandbox materialization\n---\n\nSay the magic word.\n`,
  )
}

describe("sandbox provisioning pushes workspace agent-extensions into the sandbox config", () => {
  const previousEnv = {
    dataDir: process.env.CLAXEDO_DATA_DIR,
    authorityUrl: process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL,
    signerKey: process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM,
    signerPublicKey: process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM,
    signerAlgorithm: process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM,
  }
  let dataRoot = ""

  beforeAll(async () => {
    dataRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claxedo-w4-data-"))
    process.env.CLAXEDO_DATA_DIR = dataRoot
    // Self-host shape: NO Convex authority URL → the runtime snapshot must
    // hydrate from the local SQLite authority instead.
    delete process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL
    const keyPair = await generateKeyPair("EdDSA", { extractable: true })
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM = await exportPKCS8(keyPair.privateKey)
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = await exportSPKI(keyPair.publicKey)
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM = "EdDSA"
  })

  afterAll(async () => {
    for (const [key, value] of [
      ["CLAXEDO_DATA_DIR", previousEnv.dataDir],
      ["CLAXEDO_WORKSPACE_AUTHORITY_URL", previousEnv.authorityUrl],
      ["CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM", previousEnv.signerKey],
      ["CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM", previousEnv.signerPublicKey],
      ["CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM", previousEnv.signerAlgorithm],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fs.promises.rm(dataRoot, { recursive: true, force: true })
  })

  const trackedWorkspaceIds: string[] = []
  afterEach(() => {
    for (const id of trackedWorkspaceIds) __unregisterRuntimeForTest(id)
    trackedWorkspaceIds.length = 0
  })

  test("sqlite-authority install reaches the provisioning push and materializes into a fake sandbox FS", async () => {
    const workspaceId = "ws-w4-sqlite"
    const owner = signedAuth("user_w4_owner")
    // Built before the record, because the lock must carry the digest of the
    // exact tree the replay below is handed — that is what materialization
    // verifies against.
    const packageRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claxedo-w4-pkg-"))
    await writeSkillPackageFixture(packageRoot, "sandbox-probe")
    const record = extensionRecord("sandbox-skill", await digestDirectory(packageRoot))

    // Declare the extension for the workspace the way the signed install
    // route does on self-host: a record in the local SQLite authority.
    const authority = createSqliteWorkspaceAuthority()
    await authority.createCloudWorkspace(owner, { workspaceId, displayName: "W4" })
    await authority.upsertWorkspaceAgentExtension(owner, {
      workspaceId,
      extensionId: record.desired.id,
      packageName: record.desired.package_name,
      desired: record.desired,
      lock: record.lock,
    })

    const runtime = await startRecordingServer()
    try {
      // Provisioning-time shape: a ready CLOUD runtime state, exactly what
      // `markSandboxReady` holds when it calls `pushRuntimeConfig(state)`.
      const state = __registerReadyRuntimeForTest({
        workspaceId,
        url: runtime.url,
        kind: "cloud",
        remote_directory: "/workspace",
      })
      trackedWorkspaceIds.push(workspaceId)

      await pushRuntimeConfig(state)

      expect(runtime.received).toHaveLength(1)
      expect(runtime.received[0]).toMatchObject({ method: "POST", url: "/api/wr/config" })
      const body = runtime.received[0]?.body as PushedSnapshot
      const install = body.agent_extensions?.installs.find((item) => item.desired.id === "sandbox-skill")
      expect(install).toBeDefined()
      expect(install?.effective.enabled).toBe(true)
      expect(install?.lock?.resolved_sha).toBe(record.lock.resolved_sha)

      // Fake sandbox: replay the EXACT pushed body against a temp dir with
      // the same replay entrypoint the in-sandbox workspace-runtime uses on
      // config apply (runtime.ts → applyRuntimeAgentExtensions). The package
      // root is injected so the test does not fetch from GitHub.
      const sandboxDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claxedo-w4-sandbox-"))
      const sandboxHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claxedo-w4-home-"))
      try {
        await applyRuntimeAgentExtensions(body.agent_extensions, sandboxDir, {
          packageRoots: { "sandbox-skill": packageRoot },
          homeDir: sandboxHome,
        })

        // The harness-visible artifact: claude looks for project skills at
        // <projectDir>/.claude/skills/<name>/SKILL.md inside the sandbox.
        const skillFile = path.join(sandboxDir, ".claude", "skills", "sandbox-probe", "SKILL.md")
        expect(fs.existsSync(skillFile)).toBe(true)
        expect(await fs.promises.readFile(skillFile, "utf8")).toContain("Say the magic word.")

        // Since the 2026-07-30 state-root move the replay ledger is
        // host-owned (machine scope under CLAXEDO_DATA_DIR — in a real
        // sandbox that is the sandbox's own data dir), never written into
        // the workspace checkout.
        const materialized = JSON.parse(await fs.promises.readFile(
          path.join(process.env.CLAXEDO_DATA_DIR!, "agent-extensions", "materialized.json"),
          "utf8",
        )) as { packages: Record<string, { status: string; components: Array<{ status: string; type: string }> }> }
        expect(materialized.packages["sandbox-skill"]?.status).toBe("applied")
        expect(materialized.packages["sandbox-skill"]?.components).toEqual([
          expect.objectContaining({ type: "skill", status: "applied" }),
        ])
      } finally {
        await Promise.all([
          fs.promises.rm(sandboxDir, { recursive: true, force: true }),
          fs.promises.rm(sandboxHome, { recursive: true, force: true }),
        ])
      }
    } finally {
      await runtime.stop()
      await fs.promises.rm(packageRoot, { recursive: true, force: true })
    }
  })

  test("mirror-only install (authority-less mounts) also reaches the provisioning push", async () => {
    const workspaceId = "ws-w4-mirror"
    const record = extensionRecord("mirror-skill")
    await mirrorWorkspaceAgentExtensionRecord({ workspaceId, record })

    const runtime = await startRecordingServer()
    try {
      const state = __registerReadyRuntimeForTest({
        workspaceId,
        url: runtime.url,
        kind: "cloud",
        remote_directory: "/workspace",
      })
      trackedWorkspaceIds.push(workspaceId)

      await pushRuntimeConfig(state)

      expect(runtime.received).toHaveLength(1)
      const body = runtime.received[0]?.body as PushedSnapshot
      const install = body.agent_extensions?.installs.find((item) => item.desired.id === "mirror-skill")
      expect(install).toBeDefined()
      expect(install?.effective.enabled).toBe(true)
    } finally {
      await runtime.stop()
    }
  })
})
