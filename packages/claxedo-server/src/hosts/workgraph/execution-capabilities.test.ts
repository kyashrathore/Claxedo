import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { describe, expect, test } from "vitest"
import type { ConnectionsService } from "@claxedo/connections"
import type { SandboxManager } from "@claxedo/sandbox-manager"
import { EXECUTION_CAPABILITY_CATALOG_MAX_AGE_MS, type WorkGraphContext } from "@claxedo/workgraph/contracts"
import type { SignedControlPlaneAuth } from "../../control-plane/auth"
import type { WorkspaceAuthority } from "../../control-plane/authority"
import type { RelayProvider } from "../../adapters/relay"
import { createExecutionCapabilitiesPort } from "./execution-capabilities"
import { createHostedExecutionCapabilities } from "./hosted-execution-capabilities"
import { createLocalExecutionCapabilities } from "./local-execution-capabilities"

const context = {
  organizationId: "org_1",
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
    all: [
      {
        id: "openai",
        models: {
          current: { id: "gpt-5", name: "GPT-5", status: "active", variants: { low: {}, high: {} } },
          old: { id: "gpt-4", name: "GPT-4", status: "deprecated", variants: {} },
        },
      },
      {
        id: "anthropic",
        models: { current: { id: "claude", name: "Claude", status: "active", variants: {} } },
      },
    ],
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
      },
      readRuntime: async () => runtime,
      readRepository: async () => ({ remoteUrl: "git@example.test:repo.git", baseRevisions: ["HEAD", "main"] }),
      readConnections: async () => [
        {
          id: "connection_1" as never,
          integrationId: "github",
          scope: "team",
          grantedCapabilities: ["work-source"],
        },
      ],
      connectionToolIds: ["connection_work_source_list"],
      now: () => 123,
    })

    await expect(capabilities.read(context, {})).resolves.toMatchObject({
      organizationId: "org_1",
      ownerUserId: "owner_1",
      observedAt: 123,
      expiresAt: 123 + EXECUTION_CAPABILITY_CATALOG_MAX_AGE_MS,
      models: [{ providerId: "openai", modelId: "gpt-5", efforts: ["low", "high"] }],
      tools: [
        { id: "terminal" },
        { id: "read" },
        { id: "connection_work_source_list", requiresConnectionCapability: "work-source" },
      ],
      environments: [
        {
          kind: "local_worktree",
        },
      ],
    })
  })

  test("publishes only variants executable by the Session V2 model catalog", async () => {
    const capabilities = createExecutionCapabilitiesPort({
      environment: {
        kind: "hosted_workspace",
        repositoryRequired: false,
        remoteUrlInput: true,
        baseRevisionInput: true,
      },
      readRuntime: async () => ({
        ...runtime,
        providers: {
          data: [
            {
              id: "mimo-v2.5-free",
              providerID: "opencode",
              name: "MiMo V2.5 Free",
              status: "active",
              enabled: true,
              variants: [],
            },
            {
              id: "gpt-5",
              providerID: "openai",
              name: "GPT-5",
              status: "active",
              enabled: true,
              variants: [{ id: "high" }],
            },
            {
              id: "retired",
              providerID: "openai",
              status: "deprecated",
              enabled: true,
              variants: [],
            },
          ],
        },
      }),
      readRepository: async () => ({ baseRevisions: [] }),
      readConnections: async () => [],
      now: () => 123,
    })

    await expect(capabilities.read(context, {})).resolves.toMatchObject({
      models: [
        { providerId: "opencode", modelId: "mimo-v2.5-free", efforts: ["default"] },
        { providerId: "openai", modelId: "gpt-5", efforts: ["default", "high"] },
      ],
    })
  })

  test("gives every live observation an exact immutable revision and bounded expiry", async () => {
    let now = 100
    const capabilities = createExecutionCapabilitiesPort({
      environment: {
        kind: "local_worktree",
        repositoryRequired: true,
        remoteUrlInput: false,
        baseRevisionInput: true,
      },
      readRuntime: async () => runtime,
      readRepository: async () => ({ baseRevisions: ["HEAD"] }),
      readConnections: async () => [],
      now: () => now,
    })

    const first = await capabilities.read(context, {})
    const retry = await capabilities.read(context, {})
    now += 1
    const second = await capabilities.read(context, {})
    expect(first.catalogRevision).toMatch(/^[0-9a-f]{64}$/)
    expect(retry.catalogRevision).toBe(first.catalogRevision)
    expect(second.catalogRevision).not.toBe(first.catalogRevision)
    expect(second).toMatchObject({
      observedAt: 101,
      expiresAt: 101 + EXECUTION_CAPABILITY_CATALOG_MAX_AGE_MS,
    })
  })

  test("uses the canonical build Agent when a harness cannot enumerate live Agent choices", async () => {
    const capabilities = createExecutionCapabilitiesPort({
      environment: {
        kind: "local_worktree",
        repositoryRequired: true,
        remoteUrlInput: false,
        baseRevisionInput: true,
      },
      readRuntime: async () => ({ ...runtime, agents: [] }),
      readRepository: async () => ({ baseRevisions: ["HEAD"] }),
      readConnections: async () => [],
    })

    await expect(capabilities.read(context, {})).resolves.toMatchObject({
      agents: [{ harnessId: "opencode", id: "build", label: "build", mode: "primary" }],
    })
  })

  test("fails closed when a non-empty Agent catalog contains no valid choices", async () => {
    const capabilities = createExecutionCapabilitiesPort({
      environment: {
        kind: "local_worktree",
        repositoryRequired: true,
        remoteUrlInput: false,
        baseRevisionInput: true,
      },
      readRuntime: async () => ({ ...runtime, agents: [{ description: "missing name" }] }),
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

  test("normalizes malformed assembled Connection metadata into the public capability error", async () => {
    const capabilities = createExecutionCapabilitiesPort({
      environment: {
        kind: "local_worktree",
        repositoryRequired: true,
        remoteUrlInput: false,
        baseRevisionInput: true,
      },
      readRuntime: async () => runtime,
      readRepository: async () => ({ baseRevisions: ["HEAD"] }),
      readConnections: async () => [
        {
          id: "connection_1",
          provider: "github",
          scope: "organization",
          grantedCapabilities: ["work-source"],
        } as never,
      ],
    })

    await expect(capabilities.read(context, {})).rejects.toMatchObject({
      code: "execution_capabilities_unavailable",
      capability: "connections",
      reason: "catalog_invalid",
      retryable: false,
    })
  })

  test("reads every Session composer harness plus live OpenCode and Git catalogs", async () => {
    const directory = await gitRepository()
    const previousBackend = process.env.CLAXEDO_PI_MODEL_BACKEND
    const previousOpenAiKey = process.env.OPENAI_API_KEY
    process.env.CLAXEDO_PI_MODEL_BACKEND = "1"
    process.env.OPENAI_API_KEY = "test-key"
    try {
      const requested: string[] = []
      const capabilities = createLocalExecutionCapabilities({
        repositoryDirectory: path.join(directory, "ledger"),
        resolveRepositoryDirectory: (requestedDirectory) => (requestedDirectory === directory ? directory : undefined),
        harness: async () => "opencode",
        now: () => 456,
        opencodeRequest: async (request) => {
          requested.push(new URL(request.url).pathname)
          const value =
            new URL(request.url).pathname === "/agent"
              ? runtime.agents
              : new URL(request.url).pathname === "/api/model"
                ? runtime.providers
                : runtime.tools
          return Response.json(value)
        },
      })

      const result = await capabilities.read(context, { directory })
      expect(requested).toEqual(["/agent", "/api/model", "/experimental/tool/ids"])
      expect(result.repository.baseRevisions).toContain("HEAD")
      expect(result.repository.baseRevisions).toContain("main")
      expect(result.harnesses).toEqual([
        { id: "opencode" },
        { id: "claude-acp" },
        { id: "codex-acp" },
        { id: "cursor-acp" },
        { id: "claude-sdk" },
        { id: "codex-app-server" },
        { id: "cursor-sdk" },
        { id: "pi" },
      ])
      expect(result.models).toEqual(expect.arrayContaining([
        expect.objectContaining({ harnessId: "claude-acp" }),
        expect.objectContaining({ harnessId: "codex-acp" }),
        expect.objectContaining({ harnessId: "cursor-acp" }),
        expect.objectContaining({ harnessId: "claude-sdk" }),
        expect.objectContaining({ harnessId: "codex-app-server" }),
        expect.objectContaining({ harnessId: "cursor-sdk" }),
        expect.objectContaining({ harnessId: "pi" }),
        expect.objectContaining({ harnessId: "opencode" }),
      ]))
    } finally {
      if (previousBackend === undefined) delete process.env.CLAXEDO_PI_MODEL_BACKEND
      else process.env.CLAXEDO_PI_MODEL_BACKEND = previousBackend
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previousOpenAiKey
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("uses live Codex ACP model options for execution capabilities", async () => {
    const directory = await gitRepository()
    try {
      const capabilities = createLocalExecutionCapabilities({
        repositoryDirectory: directory,
        harness: async () => "codex-acp",
        harnessConfigOptions: async (harness) => harness === "codex-acp" ? [{
          id: "model",
          currentValue: "gpt-5.6-sol",
          options: [{ value: "gpt-5.6-sol", name: "GPT-5.6-Sol" }],
        }] : [],
        opencodeRequest: async (request) => {
          const pathname = new URL(request.url).pathname
          return Response.json(
            pathname === "/agent" ? runtime.agents : pathname === "/api/model" ? runtime.providers : runtime.tools,
          )
        },
      })

      const result = await capabilities.read(context, {})
      expect(result.models.filter((model) => model.harnessId === "codex-acp")).toEqual([{
        harnessId: "codex-acp",
        providerId: "codex-acp",
        modelId: "gpt-5.6-sol",
        label: "GPT-5.6-Sol",
        efforts: ["low", "medium", "high"],
      }])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("advertises only connected organization-owned team Connections available to execution", async () => {
    const directory = await gitRepository()
    const partitions: unknown[] = []
    try {
      const capabilities = createLocalExecutionCapabilities({
        repositoryDirectory: directory,
        harness: async () => "opencode",
        opencodeRequest: async (request) => {
          const pathname = new URL(request.url).pathname
          return Response.json(
            pathname === "/agent" ? runtime.agents : pathname === "/api/model" ? runtime.providers : runtime.tools,
          )
        },
        connections: {
          list: async (partition: unknown) => {
            partitions.push(partition)
            return [
              {
                id: "connection_team",
                integrationId: "github",
                scope: "team",
                grantedCapabilities: ["work-source"],
                fields: {},
                status: "connected",
                createdAt: 1,
                updatedAt: 1,
              },
              {
                id: "connection_personal",
                integrationId: "github",
                scope: "personal",
                grantedCapabilities: ["work-source"],
                fields: {},
                status: "connected",
                createdAt: 1,
                updatedAt: 1,
              },
              {
                id: "connection_degraded",
                integrationId: "linear",
                scope: "team",
                grantedCapabilities: ["work-source"],
                fields: {},
                status: "degraded",
                createdAt: 1,
                updatedAt: 1,
              },
            ]
          },
        } as unknown as ConnectionsService,
        resolveTeamOwner: () => "org:org_1",
      })

      const result = await capabilities.read(context, {})
      expect(partitions).toEqual([{ owner: "owner_1", teamOwner: "org:org_1" }])
      expect(result.connections).toEqual([
        {
          id: "connection_team",
          integrationId: "github",
          scope: "team",
          grantedCapabilities: ["work-source"],
        },
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("reads an existing managed catalog without provisioning on GET and provisions only on explicit refresh", async () => {
    const requested: string[] = []
    const ensured: string[] = []
    const destroyed: string[] = []
    const released: string[] = []
    let modelReads = 0
    let ready = false
    const capabilities = createHostedExecutionCapabilities({
      authority: {
        resolveOrgId: async () => "org_1",
      } as unknown as WorkspaceAuthority,
      sandboxManager: {
        target: async (workspaceId: string) =>
          ready
            ? {
                status: "ready",
                workspaceId,
                sandboxId: "sandbox_1",
                url: "https://host.test",
                hostId: "host_1",
                epoch: 1,
                homeRegion: "us-east",
              }
            : { status: "unavailable", reason: "missing" },
        ensure: async (workspaceId: string) => {
          ensured.push(workspaceId)
          ready = true
          return {
            status: "ready",
            workspaceId,
            sandboxId: "sandbox_1",
            url: "https://host.test",
            hostId: "host_1",
            epoch: 1,
            homeRegion: "us-east",
          }
        },
        destroy: async (workspaceId: string) => {
          destroyed.push(workspaceId)
          ready = false
          return { ok: true, status: "destroyed" }
        },
        release: async (workspaceId: string) => {
          released.push(workspaceId)
          return { released: true }
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
      modelCatalogRetryDelayMs: 0,
      request: async (request) => {
        const url = new URL(request)
        requested.push(url.pathname)
        if (url.pathname.endsWith("/session/capabilities")) return Response.json(runtime.harness)
        if (url.pathname.endsWith("/agent")) return Response.json(runtime.agents)
        if (url.pathname.endsWith("/api/model")) {
          modelReads += 1
          return Response.json(modelReads === 1 ? { data: [] } : runtime.providers)
        }
        if (url.pathname.endsWith("/experimental/tool/ids")) return Response.json(runtime.tools)
        throw new Error(`Unexpected request ${url.pathname}`)
      },
    })

    await expect(capabilities.read(context, {})).rejects.toEqual(
      expect.objectContaining({
        capability: "catalog_workspace",
        reason: "runtime_unavailable",
        retryable: true,
      }),
    )
    expect(ensured).toEqual([])
    const result = await capabilities.refresh(context)
    expect(ensured).toHaveLength(1)
    expect(ensured[0]).toMatch(/^wg-catalog-/)
    expect(destroyed).toEqual(ensured)
    expect(released).toEqual(ensured)
    expect(result.environments).toEqual([
      {
        kind: "hosted_workspace",
        repositoryRequired: false,
        remoteUrlInput: true,
        baseRevisionInput: true,
      },
    ])
    expect(requested.map((path) => path.replace(/\/workspaces\/wg-catalog-[^/]+/, "/workspaces/catalog"))).toEqual([
      "/workspaces/catalog/session/capabilities",
      "/workspaces/catalog/agent",
      "/workspaces/catalog/api/model",
      "/workspaces/catalog/experimental/tool/ids",
      "/workspaces/catalog/api/model",
    ])
  })

  test("coalesces concurrent refresh and read callers behind one transient catalog workspace", async () => {
    const catalogStarted = Promise.withResolvers<void>()
    const releaseCatalog = Promise.withResolvers<void>()
    const ensured: string[] = []
    const targeted: string[] = []
    const destroyed: string[] = []
    const released: string[] = []
    const requested: string[] = []
    const capabilities = createHostedExecutionCapabilities({
      authority: { resolveOrgId: async () => "org_1" } as unknown as WorkspaceAuthority,
      sandboxManager: {
        ensure: async (workspaceId: string) => {
          ensured.push(workspaceId)
          return {
            status: "ready",
            workspaceId,
            sandboxId: "sandbox_1",
            url: "https://host.test",
            hostId: "host_1",
            epoch: 1,
            homeRegion: "us-east",
          }
        },
        target: async (workspaceId: string) => {
          targeted.push(workspaceId)
          return {
            status: "ready",
            workspaceId,
            sandboxId: "sandbox_1",
            url: "https://host.test",
            hostId: "host_1",
            epoch: 1,
            homeRegion: "us-east",
          }
        },
        destroy: async (workspaceId: string) => {
          destroyed.push(workspaceId)
          return { ok: true, status: "destroyed" }
        },
        release: async (workspaceId: string) => {
          released.push(workspaceId)
          return { released: true }
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
        const pathname = new URL(request).pathname
        requested.push(pathname)
        catalogStarted.resolve()
        await releaseCatalog.promise
        if (pathname.endsWith("/session/capabilities")) return Response.json(runtime.harness)
        if (pathname.endsWith("/agent")) return Response.json(runtime.agents)
        if (pathname.endsWith("/api/model")) return Response.json(runtime.providers)
        if (pathname.endsWith("/experimental/tool/ids")) return Response.json(runtime.tools)
        throw new Error(`Unexpected request ${pathname}`)
      },
    })

    const first = capabilities.refresh(context)
    await catalogStarted.promise
    const second = capabilities.refresh(context)
    const concurrentRead = capabilities.read(context, {})
    await Promise.resolve()
    expect(ensured).toHaveLength(1)
    expect(destroyed).toEqual([])
    expect(released).toEqual([])
    releaseCatalog.resolve()

    const results = await Promise.all([first, second, concurrentRead])
    expect(new Set(results.map((result) => result.catalogRevision)).size).toBe(1)
    expect(requested).toHaveLength(4)
    expect(targeted).toEqual(ensured)
    expect(destroyed).toEqual(ensured)
    expect(released).toEqual(ensured)
    await capabilities.read(context, {})
    expect(targeted).toHaveLength(1)
  })

  test("waits for an active catalog read before refreshing and destroying its workspace", async () => {
    const readStarted = Promise.withResolvers<void>()
    const releaseRead = Promise.withResolvers<void>()
    const ensured: string[] = []
    const destroyed: string[] = []
    let blockExistingRead = true
    const capabilities = createHostedExecutionCapabilities({
      authority: { resolveOrgId: async () => "org_1" } as unknown as WorkspaceAuthority,
      sandboxManager: {
        target: async (workspaceId: string) => ({
          status: "ready",
          workspaceId,
          sandboxId: "sandbox_1",
          url: "https://host.test",
          hostId: "host_1",
          epoch: 1,
          homeRegion: "us-east",
        }),
        ensure: async (workspaceId: string) => {
          ensured.push(workspaceId)
          return {
            status: "ready",
            workspaceId,
            sandboxId: "sandbox_1",
            url: "https://host.test",
            hostId: "host_1",
            epoch: 1,
            homeRegion: "us-east",
          }
        },
        destroy: async (workspaceId: string) => {
          destroyed.push(workspaceId)
          return { ok: true, status: "destroyed" }
        },
        release: async () => ({ released: true }),
      } as unknown as SandboxManager,
      relayProvider: {
        mintRuntimeAccessToken: async () => ({ token: "runtime-token", expiresAt: 1, jti: "jti_1" }),
        getRelayEndpoint: async () => "https://relay.test",
      } as unknown as RelayProvider,
      defaultHomeRegion: "us-east",
      auth: () => signedAuth,
      readConnections: async () => [],
      connectionToolIds: [],
      request: async (request) => {
        const pathname = new URL(request).pathname
        if (blockExistingRead) {
          readStarted.resolve()
          await releaseRead.promise
        }
        if (pathname.endsWith("/session/capabilities")) return Response.json(runtime.harness)
        if (pathname.endsWith("/agent")) return Response.json(runtime.agents)
        if (pathname.endsWith("/api/model")) return Response.json(runtime.providers)
        if (pathname.endsWith("/experimental/tool/ids")) return Response.json(runtime.tools)
        throw new Error(`Unexpected request ${pathname}`)
      },
    })

    const read = capabilities.read(context, {})
    await readStarted.promise
    const refresh = capabilities.refresh(context)
    await Promise.resolve()
    expect(ensured).toEqual([])
    expect(destroyed).toEqual([])
    blockExistingRead = false
    releaseRead.resolve()
    await Promise.all([read, refresh])
    expect(ensured).toHaveLength(1)
    expect(destroyed).toEqual(ensured)
  })

  test("returns a typed refresh failure when a ready catalog workspace cannot be destroyed", async () => {
    let released = false
    const capabilities = createHostedExecutionCapabilities({
      authority: { resolveOrgId: async () => "org_1" } as unknown as WorkspaceAuthority,
      sandboxManager: {
        ensure: async (workspaceId: string) => ({
          status: "ready",
          workspaceId,
          sandboxId: "sandbox_1",
          url: "https://host.test",
          hostId: "host_1",
          epoch: 1,
          homeRegion: "us-east",
        }),
        target: async (workspaceId: string) => ({
          status: "ready",
          workspaceId,
          sandboxId: "sandbox_1",
          url: "https://host.test",
          hostId: "host_1",
          epoch: 1,
          homeRegion: "us-east",
        }),
        destroy: async () => ({ ok: false, reason: "runtime_lease_not_ready" }),
        release: async () => {
          released = true
          return { released: true }
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
      request: async (request) => {
        const pathname = new URL(request).pathname
        if (pathname.endsWith("/session/capabilities")) return Response.json(runtime.harness)
        if (pathname.endsWith("/agent")) return Response.json(runtime.agents)
        if (pathname.endsWith("/api/model")) return Response.json(runtime.providers)
        if (pathname.endsWith("/experimental/tool/ids")) return Response.json(runtime.tools)
        throw new Error(`Unexpected request ${pathname}`)
      },
    })

    await expect(capabilities.refresh(context)).rejects.toMatchObject({
      code: "execution_capabilities_unavailable",
      capability: "catalog_workspace",
      reason: "catalog_workspace_unavailable",
      retryable: true,
    })
    expect(released).toBe(false)
  })

  test("destroys and releases the transient workspace when hosted catalog discovery fails", async () => {
    const destroyed: string[] = []
    const released: string[] = []
    const capabilities = createHostedExecutionCapabilities({
      authority: { resolveOrgId: async () => "org_1" } as unknown as WorkspaceAuthority,
      sandboxManager: {
        ensure: async (workspaceId: string) => ({
          status: "ready",
          workspaceId,
          sandboxId: "sandbox_1",
          url: "https://host.test",
          hostId: "host_1",
          epoch: 1,
          homeRegion: "us-east",
        }),
        target: async (workspaceId: string) => ({
          status: "ready",
          workspaceId,
          sandboxId: "sandbox_1",
          url: "https://host.test",
          hostId: "host_1",
          epoch: 1,
          homeRegion: "us-east",
        }),
        destroy: async (workspaceId: string) => {
          destroyed.push(workspaceId)
          return { ok: true, status: "destroyed" }
        },
        release: async (workspaceId: string) => {
          released.push(workspaceId)
          return { released: true }
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
      request: async () => new Response("catalog unavailable", { status: 503 }),
    })

    await expect(capabilities.refresh(context)).rejects.toMatchObject({
      code: "execution_capabilities_unavailable",
      capability: "runtime",
      reason: "runtime_unavailable",
      retryable: true,
    })
    expect(destroyed).toHaveLength(1)
    expect(released).toEqual(destroyed)
  })

  test("bounds stalled hosted catalog requests and identifies the failed endpoint", async () => {
    const destroyed: string[] = []
    const capabilities = createHostedExecutionCapabilities({
      authority: { resolveOrgId: async () => "org_1" } as unknown as WorkspaceAuthority,
      sandboxManager: {
        ensure: async (workspaceId: string) => ({
          status: "ready",
          workspaceId,
          sandboxId: "sandbox_1",
          url: "https://host.test",
          hostId: "host_1",
          epoch: 1,
          homeRegion: "us-east",
        }),
        target: async (workspaceId: string) => ({
          status: "ready",
          workspaceId,
          sandboxId: "sandbox_1",
          url: "https://host.test",
          hostId: "host_1",
          epoch: 1,
          homeRegion: "us-east",
        }),
        destroy: async (workspaceId: string) => {
          destroyed.push(workspaceId)
          return { ok: true, status: "destroyed" }
        },
        release: async () => ({ released: true }),
      } as unknown as SandboxManager,
      relayProvider: {
        mintRuntimeAccessToken: async () => ({ token: "runtime-token", expiresAt: 1, jti: "jti_1" }),
        getRelayEndpoint: async () => "https://relay.test",
      } as unknown as RelayProvider,
      defaultHomeRegion: "us-east",
      auth: () => signedAuth,
      readConnections: async () => [],
      connectionToolIds: [],
      requestTimeoutMs: 10,
      request: async (request, init) => {
        if (!new URL(request).pathname.endsWith("/api/model")) return Response.json({})
        return await new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
        })
      },
    })

    await expect(capabilities.refresh(context)).rejects.toMatchObject({
      code: "execution_capabilities_unavailable",
      message: expect.stringContaining("/api/model via relay.test failed"),
    })
    expect(destroyed).toHaveLength(1)
  })

  test("waits for a newly provisioned catalog workspace before discovering capabilities", async () => {
    let ensureCalls = 0
    const capabilities = createHostedExecutionCapabilities({
      authority: { resolveOrgId: async () => "org_1" } as unknown as WorkspaceAuthority,
      sandboxManager: {
        ensure: async (workspaceId: string) => {
          ensureCalls += 1
          if (ensureCalls === 1) return { status: "provisioning", retryAfterMs: 1 }
          return {
            status: "ready",
            workspaceId,
            sandboxId: "sandbox_1",
            url: "https://host.test",
            hostId: "host_1",
            epoch: 1,
            homeRegion: "us-east",
          }
        },
        target: async (workspaceId: string) => ({
          status: "ready",
          workspaceId,
          sandboxId: "sandbox_1",
          url: "https://host.test",
          hostId: "host_1",
          epoch: 1,
          homeRegion: "us-east",
        }),
        destroy: async () => ({ ok: true, status: "destroyed" }),
        release: async () => ({ released: true }),
      } as unknown as SandboxManager,
      relayProvider: {
        mintRuntimeAccessToken: async () => ({ token: "runtime-token", expiresAt: 1, jti: "jti_1" }),
        getRelayEndpoint: async () => "https://relay.test",
      } as unknown as RelayProvider,
      defaultHomeRegion: "us-east",
      auth: () => signedAuth,
      readConnections: async () => [],
      connectionToolIds: [],
      request: async (request) => {
        const pathname = new URL(request).pathname
        if (pathname.endsWith("/session/capabilities")) return Response.json(runtime.harness)
        if (pathname.endsWith("/agent")) return Response.json(runtime.agents)
        if (pathname.endsWith("/api/model")) return Response.json(runtime.providers)
        if (pathname.endsWith("/experimental/tool/ids")) return Response.json(runtime.tools)
        throw new Error(`Unexpected request ${pathname}`)
      },
    })

    await expect(capabilities.refresh(context)).resolves.toMatchObject({
      environments: [{ kind: "hosted_workspace" }],
      harnesses: [{ id: "opencode" }],
    })
    expect(ensureCalls).toBe(2)
  })

  test("isolates hosted catalog workspace identity and cache by organization and owner", async () => {
    const ensured: Array<{ workspaceId: string; labels: Record<string, string> }> = []
    const capabilities = createHostedExecutionCapabilities({
      authority: { resolveOrgId: async () => "org_1" } as unknown as WorkspaceAuthority,
      sandboxManager: {
        ensure: async (workspaceId: string, options: { labels: Record<string, string> }) => {
          ensured.push({ workspaceId, labels: options.labels })
          return { status: "provisioning", retryAfterMs: 1 }
        },
      } as unknown as SandboxManager,
      relayProvider: {} as RelayProvider,
      defaultHomeRegion: "us-east",
      auth: () => signedAuth,
      readConnections: async () => [],
      connectionToolIds: [],
      catalogStartupTimeoutMs: 2,
    })
    const otherOrganization = { ...context, organizationId: "org_2" } as WorkGraphContext

    await expect(capabilities.refresh(context)).rejects.toMatchObject({ reason: "runtime_unavailable" })
    await expect(capabilities.refresh(otherOrganization)).rejects.toMatchObject({ reason: "runtime_unavailable" })

    expect(new Set(ensured.map((entry) => entry.workspaceId)).size).toBe(2)
    expect([...new Map(ensured.map((entry) => [entry.workspaceId, entry.labels])).values()]).toEqual([
      { workload: "workgraph-catalog", organizationId: "org_1", ownerUserId: "owner_1" },
      { workload: "workgraph-catalog", organizationId: "org_2", ownerUserId: "owner_1" },
    ])
  })

  test("expires the tenant-scoped hosted runtime cache at the catalog freshness boundary", async () => {
    let now = 1_000
    const requested: string[] = []
    const capabilities = createHostedExecutionCapabilities({
      authority: { resolveOrgId: async () => "org_1" } as unknown as WorkspaceAuthority,
      sandboxManager: {
        target: async (workspaceId: string) => ({
          status: "ready",
          workspaceId,
          sandboxId: "sandbox_1",
          url: "https://host.test",
          hostId: "host_1",
          epoch: 1,
          homeRegion: "us-east",
        }),
      } as unknown as SandboxManager,
      relayProvider: {
        mintRuntimeAccessToken: async () => ({ token: "runtime-token", expiresAt: 1, jti: "jti_1" }),
        getRelayEndpoint: async () => "https://relay.test",
      } as unknown as RelayProvider,
      defaultHomeRegion: "us-east",
      auth: () => signedAuth,
      readConnections: async () => [],
      connectionToolIds: [],
      now: () => now,
      request: async (request) => {
        const pathname = new URL(request).pathname
        requested.push(pathname)
        if (pathname.endsWith("/session/capabilities")) return Response.json(runtime.harness)
        if (pathname.endsWith("/agent")) return Response.json(runtime.agents)
        if (pathname.endsWith("/api/model")) return Response.json(runtime.providers)
        if (pathname.endsWith("/experimental/tool/ids")) return Response.json(runtime.tools)
        throw new Error(`Unexpected request ${pathname}`)
      },
    })

    await capabilities.read(context, {})
    await capabilities.read(context, {})
    expect(requested).toHaveLength(4)
    now += EXECUTION_CAPABILITY_CATALOG_MAX_AGE_MS
    await capabilities.read(context, {})
    expect(requested).toHaveLength(8)
  })

  test("scopes base-revision enumeration to a validated project directory", async () => {
    const bootRepo = await gitRepository()
    const otherRepo = await gitRepositoryWithBranches()
    const validated: string[] = []
    try {
      const capabilities = createLocalExecutionCapabilities({
        repositoryDirectory: bootRepo,
        harness: async () => "opencode",
        // Only the second repository is a "known project"; everything else is unknown.
        resolveRepositoryDirectory: (directory) => {
          validated.push(directory)
          return directory === otherRepo ? otherRepo : undefined
        },
        opencodeRequest: async (request) => {
          const pathname = new URL(request.url).pathname
          return Response.json(
            pathname === "/agent" ? runtime.agents : pathname === "/api/model" ? runtime.providers : runtime.tools,
          )
        },
      })

      // No selector → nothing. The boot repository is WorkGraph's own ledger, so
      // its refs are never advertised as if they were a user project's.
      const boot = await capabilities.read(context, {})
      expect(boot.repository.baseRevisions).toEqual([])
      expect(validated).toEqual([])

      // A validated selector → THAT repository's branches, HEAD-first / newest-first.
      const scoped = await capabilities.read(context, { directory: otherRepo })
      expect(scoped.repository.baseRevisions).toEqual(["HEAD", "newer-feature", "older-feature", "main"])
      expect(validated).toEqual([otherRepo])
    } finally {
      await rm(bootRepo, { recursive: true, force: true })
      await rm(otherRepo, { recursive: true, force: true })
    }
  })

  test("fails closed on an unknown or non-existent directory without running git against it", async () => {
    const bootRepo = await gitRepository()
    const validated: string[] = []
    try {
      const capabilities = createLocalExecutionCapabilities({
        repositoryDirectory: bootRepo,
        harness: async () => "opencode",
        // Unknown project directory: the validator returns nothing, so git must
        // never be invoked against the caller-supplied path.
        resolveRepositoryDirectory: (directory) => {
          validated.push(directory)
          return undefined
        },
        opencodeRequest: async (request) => {
          const pathname = new URL(request.url).pathname
          return Response.json(
            pathname === "/agent" ? runtime.agents : pathname === "/api/model" ? runtime.providers : runtime.tools,
          )
        },
      })

      await expect(capabilities.read(context, { directory: "/not/a/known/project" })).rejects.toMatchObject({
        code: "execution_capabilities_unavailable",
        capability: "repository",
        reason: "repository_unavailable",
        retryable: false,
      })
      expect(validated).toEqual(["/not/a/known/project"])

      // A relative selector is rejected before the validator is even consulted.
      await expect(capabilities.read(context, { directory: "relative/path" })).rejects.toMatchObject({
        capability: "repository",
        reason: "repository_unavailable",
      })
      expect(validated).toEqual(["/not/a/known/project"])
    } finally {
      await rm(bootRepo, { recursive: true, force: true })
    }
  })

  test("fails closed when the validator resolves a directory that no longer exists", async () => {
    const bootRepo = await gitRepository()
    const missing = path.join(os.tmpdir(), "workgraph-capabilities-missing-does-not-exist")
    try {
      const capabilities = createLocalExecutionCapabilities({
        repositoryDirectory: bootRepo,
        harness: async () => "opencode",
        resolveRepositoryDirectory: () => missing,
        opencodeRequest: async (request) => {
          const pathname = new URL(request.url).pathname
          return Response.json(
            pathname === "/agent" ? runtime.agents : pathname === "/api/model" ? runtime.providers : runtime.tools,
          )
        },
      })

      await expect(capabilities.read(context, { directory: missing })).rejects.toMatchObject({
        capability: "repository",
        reason: "repository_unavailable",
        retryable: false,
      })
    } finally {
      await rm(bootRepo, { recursive: true, force: true })
    }
  })

  test("suggests only local branches for the base revision, most recently committed first", async () => {
    const ledger = await gitRepository()
    const directory = await gitRepositoryWithBranches()
    try {
      const capabilities = createLocalExecutionCapabilities({
        repositoryDirectory: ledger,
        harness: async () => "opencode",
        resolveRepositoryDirectory: (requested) => (requested === directory ? directory : undefined),
        opencodeRequest: async (request) => {
          const pathname = new URL(request.url).pathname
          return Response.json(
            pathname === "/agent" ? runtime.agents : pathname === "/api/model" ? runtime.providers : runtime.tools,
          )
        },
      })

      const result = await capabilities.read(context, { directory })
      expect(result.repository.baseRevisions).toEqual(["HEAD", "newer-feature", "older-feature", "main"])
      expect(result.repository.baseRevisions).not.toContain("origin/main")
      expect(result.repository.baseRevisions).not.toContain("upstream/main")
    } finally {
      await rm(ledger, { recursive: true, force: true })
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("never advertises the WorkGraph ledger's own refs as a user repository", async () => {
    const ledger = await gitRepositoryWithBranches()
    try {
      const capabilities = createLocalExecutionCapabilities({
        repositoryDirectory: ledger,
        harness: async () => "opencode",
        // The ledger IS a known directory here: even so, a read that resolves to
        // it must expose nothing, so the New stream dialog has no revisions to
        // render until a real project is picked.
        resolveRepositoryDirectory: (directory) => directory,
        opencodeRequest: async (request) => {
          const pathname = new URL(request.url).pathname
          return Response.json(
            pathname === "/agent" ? runtime.agents : pathname === "/api/model" ? runtime.providers : runtime.tools,
          )
        },
      })

      await expect(capabilities.read(context, {})).resolves.toMatchObject({ repository: { baseRevisions: [] } })
      await expect(capabilities.read(context, { directory: ledger })).rejects.toMatchObject({
        capability: "repository",
        reason: "repository_unavailable",
      })
    } finally {
      await rm(ledger, { recursive: true, force: true })
    }
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
  await run("git", [
    "-C",
    directory,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "initial",
  ])
  return directory
}

async function gitRepositoryWithBranches() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workgraph-capabilities-branches-"))
  const run = promisify(execFile)
  const commit = (message: string, isoDate: string) =>
    run("git", [
      "-C",
      directory,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      message,
    ], { env: { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate } })

  await run("git", ["init", "-b", "main", directory])
  await commit("initial", "2024-01-01T00:00:00Z")
  await run("git", ["-C", directory, "checkout", "-b", "older-feature"])
  await commit("older feature work", "2024-01-02T00:00:00Z")
  await run("git", ["-C", directory, "checkout", "main"])
  await run("git", ["-C", directory, "checkout", "-b", "newer-feature"])
  await commit("newer feature work", "2024-01-05T00:00:00Z")
  await run("git", ["-C", directory, "checkout", "main"])

  // Simulate remote-tracking refs (as would exist after `git fetch`) without
  // registering a real remote, so the fixture stays self-contained.
  const headSha = (await run("git", ["-C", directory, "rev-parse", "HEAD"])).stdout.trim()
  await run("git", ["-C", directory, "update-ref", "refs/remotes/origin/main", headSha])
  await run("git", ["-C", directory, "update-ref", "refs/remotes/upstream/main", headSha])

  return directory
}
