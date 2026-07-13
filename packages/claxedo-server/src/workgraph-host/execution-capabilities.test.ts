import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { describe, expect, test } from "vitest"
import type { SandboxManager } from "@claxedo/sandbox-manager"
import type { WorkGraphContext } from "@claxedo/workgraph/contracts"
import type { SignedControlPlaneAuth } from "../control-plane/auth"
import type { WorkspaceAuthority } from "../control-plane/authority"
import type { RelayProvider } from "../relay-provider"
import { createExecutionCapabilitiesPort } from "./execution-capabilities"
import { createHostedExecutionCapabilities } from "./hosted-execution-capabilities"
import { createLocalExecutionCapabilities } from "./local-execution-capabilities"

const context = {
  ownerUserId: "owner_1",
  actor: { type: "user", id: "owner_1" },
  requestId: "request_1",
  access: { mode: "owner" },
} as WorkGraphContext

const runtime = {
  harness: { harness: "opencode" },
  agents: [{ name: "build", description: "Build Agent", mode: "primary" }],
  providers: {
    connected: ["openai"],
    all: [{
      id: "openai",
      models: {
        current: { id: "gpt-5", name: "GPT-5", status: "active", variants: { low: {}, high: {} } },
        old: { id: "gpt-4", name: "GPT-4", status: "deprecated", variants: {} },
      },
    }, {
      id: "anthropic",
      models: { current: { id: "claude", name: "Claude", status: "active", variants: {} } },
    }],
  },
  tools: ["terminal", "read"],
}

describe("WorkGraph execution capability composition", () => {
  test("publishes only live connected choices and adapter-supported policy", async () => {
    const capabilities = createExecutionCapabilitiesPort({
      environment: {
        kind: "local_worktree",
        repositoryRequired: true,
        remoteUrlInput: false,
        baseRevisionInput: true,
        isolation: ["stream", "child"],
        cleanup: ["destroy_on_close", "retain"],
        integration: ["manual"],
      },
      readRuntime: async () => runtime,
      readRepository: async () => ({ remoteUrl: "git@example.test:repo.git", baseRevisions: ["HEAD", "main"] }),
      readConnections: async () => [{
        id: "connection_1" as never,
        integrationId: "github",
        scope: "team",
        grantedCapabilities: ["work-source"],
      }],
      connectionToolIds: ["connection_work_source_list"],
      now: () => 123,
    })

    await expect(capabilities.read(context, {})).resolves.toMatchObject({
      ownerUserId: "owner_1",
      observedAt: 123,
      models: [{ providerId: "openai", modelId: "gpt-5", efforts: ["low", "high"] }],
      tools: [
        { id: "terminal" },
        { id: "read" },
        { id: "connection_work_source_list", requiresConnectionCapability: "work-source" },
      ],
      environments: [{
        kind: "local_worktree",
        isolation: ["stream", "child"],
        cleanup: ["destroy_on_close", "retain"],
        integration: ["manual"],
      }],
    })
  })

  test("fails with a typed catalog error instead of treating upstream failure as an empty catalog", async () => {
    const capabilities = createExecutionCapabilitiesPort({
      environment: {
        kind: "local_worktree",
        repositoryRequired: true,
        remoteUrlInput: false,
        baseRevisionInput: true,
        isolation: ["stream"],
        cleanup: ["destroy_on_close"],
        integration: ["manual"],
      },
      readRuntime: async () => ({ ...runtime, agents: [] }),
      readRepository: async () => ({ baseRevisions: ["HEAD"] }),
      readConnections: async () => [],
    })

    await expect(capabilities.read(context, {})).rejects.toMatchObject({
      code: "execution_capabilities_unavailable",
      capability: "agents",
      reason: "catalog_invalid",
      retryable: false,
    })
  })

  test("reads local OpenCode and Git catalogs without substitute values", async () => {
    const directory = await gitRepository()
    try {
      const requested: string[] = []
      const capabilities = createLocalExecutionCapabilities({
        repositoryDirectory: directory,
        harness: async () => "opencode",
        now: () => 456,
        opencodeRequest: async (request) => {
          requested.push(new URL(request.url).pathname)
          const value = new URL(request.url).pathname === "/agent" ? runtime.agents
            : new URL(request.url).pathname === "/provider" ? runtime.providers
              : runtime.tools
          return Response.json(value)
        },
      })

      const result = await capabilities.read(context, {})
      expect(requested).toEqual(["/agent", "/provider", "/experimental/tool/ids"])
      expect(result.repository.baseRevisions).toContain("HEAD")
      expect(result.repository.baseRevisions).toContain("main")
      expect(result.harnesses).toEqual([{ id: "opencode" }])
      expect(result.models).toEqual([{ harnessId: "opencode", providerId: "openai", modelId: "gpt-5", label: "GPT-5", efforts: ["low", "high"] }])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("reads an existing managed catalog without provisioning on GET and provisions only on explicit probe", async () => {
    const requested: string[] = []
    const ensured: string[] = []
    let ready = false
    const capabilities = createHostedExecutionCapabilities({
      authority: {
        resolveOrgId: async () => "org_1",
      } as unknown as WorkspaceAuthority,
      sandboxManager: {
        target: async (workspaceId: string) => ready
          ? { status: "ready", workspaceId, sandboxId: "sandbox_1", url: "https://host.test", hostId: "host_1", epoch: 1, homeRegion: "us-east" }
          : { status: "unavailable", reason: "missing" },
        ensure: async (workspaceId: string) => {
          ensured.push(workspaceId)
          ready = true
          return { status: "ready", workspaceId, sandboxId: "sandbox_1", url: "https://host.test", hostId: "host_1", epoch: 1, homeRegion: "us-east" }
        },
      } as unknown as SandboxManager,
      relayProvider: {
        mintRuntimeAccessToken: async () => ({ token: "runtime-token", expiresAt: 1, jti: "jti_1" }),
        getRelayEndpoint: async () => "https://relay.test",
      } as unknown as RelayProvider,
      defaultHomeRegion: "us-east",
      auth: () => signedAuth,
      readConnections: async () => [],
      connectionToolIds: [],
      now: () => 789,
      request: async (request) => {
        const url = new URL(request)
        requested.push(url.pathname)
        if (url.pathname.endsWith("/session/capabilities")) return Response.json(runtime.harness)
        if (url.pathname.endsWith("/agent")) return Response.json(runtime.agents)
        if (url.pathname.endsWith("/provider")) return Response.json(runtime.providers)
        if (url.pathname.endsWith("/experimental/tool/ids")) return Response.json(runtime.tools)
        throw new Error(`Unexpected request ${url.pathname}`)
      },
    })

    await expect(capabilities.read(context, {})).rejects.toEqual(expect.objectContaining({
      capability: "catalog_workspace",
      reason: "catalog_workspace_unavailable",
    }))
    expect(ensured).toEqual([])
    const result = await capabilities.probe(context)
    expect(ensured).toHaveLength(1)
    expect(ensured[0]).toMatch(/^wg-catalog-/)
    expect(result.environments).toEqual([{
      kind: "hosted_workspace",
      repositoryRequired: false,
      remoteUrlInput: true,
      baseRevisionInput: true,
      isolation: ["stream"],
      cleanup: ["destroy_on_close"],
      integration: ["manual"],
    }])
    expect(requested.map((path) => path.replace(/\/workspaces\/wg-catalog-[^/]+/, "/workspaces/catalog"))).toEqual([
      "/workspaces/catalog/session/capabilities",
      "/workspaces/catalog/agent",
      "/workspaces/catalog/provider",
      "/workspaces/catalog/experimental/tool/ids",
    ])
  })
})

const signedAuth = {
  mode: "signed",
  token: "token",
  user: { subject: "owner_1", tokenIdentifier: "issuer|owner_1", issuer: "https://issuer.test", orgId: "clerk_org_1" },
} satisfies SignedControlPlaneAuth

async function gitRepository() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workgraph-capabilities-"))
  const run = promisify(execFile)
  await run("git", ["init", "-b", "main", directory])
  await writeFile(path.join(directory, "README.md"), "test\n")
  await run("git", ["-C", directory, "add", "README.md"])
  await run("git", ["-C", directory, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"])
  return directory
}
