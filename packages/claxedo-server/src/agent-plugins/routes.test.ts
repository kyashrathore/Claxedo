import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import {
  AgentPluginActivationStoreError,
  type AgentPluginArtifactPin,
  type MutateSignedOrganizationDefault,
  type MutateSignedUserActivation,
  type SignedActivationSnapshot,
  type SignedAgentPluginActivationStore,
  type SignedKnownPlugin,
  type UpdateSignedArtifactPin,
} from "@claxedo/server-core/agent-plugins/activation/store"
import type { ArtifactDigest } from "@claxedo/server-core/agent-plugins/activation/types"
import type {
  AgentPluginArtifactStore,
  InspectedAgentPluginArtifact,
  RetainedAgentPluginArtifact,
} from "@claxedo/server-core/agent-plugins/artifacts/types"
import type { CatalogSourceProvider } from "@claxedo/server-core/agent-plugins/ports"
import { fileSystemCollectionSource } from "@claxedo/server-core/agent-plugins/artifacts/node-tree"
import {
  isAgentPluginHarnessId,
  type AgentPluginHarnessId,
} from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import {
  ControlPlaneAuthError,
  type SignedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../authority/services"
import { HostedAgentPluginRoutes } from "./routes"
import type { AgentPluginMcpCatalogAuthenticationResolver } from "./mcp/catalog-auth"
import { hostedMcpClientMetadata } from "./mcp/client-metadata"

const roots: string[] = []

function mapKey(...parts: string[]) {
  return JSON.stringify(parts)
}

class MemoryArtifacts implements AgentPluginArtifactStore {
  readonly values = new Map<ArtifactDigest, RetainedAgentPluginArtifact>()

  async put(artifact: InspectedAgentPluginArtifact) {
    const retained = { digest: artifact.digest, root: `/retained/${artifact.digest.slice(7)}`, tree: artifact.tree, plugin: artifact.plugin }
    this.values.set(artifact.digest, retained)
    return retained
  }

  async get(digest: ArtifactDigest) {
    return this.values.get(digest)
  }
}

class MemorySignedActivations implements SignedAgentPluginActivationStore {
  private currentRevision = 0
  private readonly pins = new Map<string, SignedKnownPlugin["pins"]>()
  private readonly userDefaults = new Map<string, boolean>()
  private readonly projectOverrides = new Map<string, boolean>()
  private readonly organizationDefaults = new Set<string>()

  private subject(auth: SignedControlPlaneAuth) {
    return auth.user.subject
  }

  private org(auth: SignedControlPlaneAuth) {
    return auth.user.orgId ?? "org-main"
  }

  private checkRevision(expected: number) {
    if (expected !== this.currentRevision) {
      throw new AgentPluginActivationStoreError(
        "revision-conflict",
        `Agent plugin activation revision changed from ${expected} to ${this.currentRevision}`,
      )
    }
  }

  private supported(ids: readonly string[]): AgentPluginHarnessId[] {
    const unique = [...new Set(ids)]
    if (!unique.every(isAgentPluginHarnessId)) {
      throw new AgentPluginActivationStoreError("unsupported-harness", "Unsupported Agent Plugins harness")
    }
    return unique as AgentPluginHarnessId[]
  }

  private writablePin(pluginInstanceId: string) {
    const existing = this.pins.get(pluginInstanceId) ?? {}
    this.pins.set(pluginInstanceId, existing)
    return existing
  }

  async authorizeProject(_auth: SignedControlPlaneAuth, projectId: string) {
    if (projectId === "forbidden") {
      throw new ControlPlaneAuthError(403, "workspace_authorization_denied", "Project access denied")
    }
  }

  async revision() {
    return this.currentRevision
  }

  async listKnown() {
    const ids = new Set(this.pins.keys())
    for (const key of this.userDefaults.keys()) ids.add(JSON.parse(key)[1])
    for (const key of this.projectOverrides.keys()) ids.add(JSON.parse(key)[2])
    for (const key of this.organizationDefaults) ids.add(JSON.parse(key)[1])
    return [...ids].sort().map((pluginInstanceId) => ({
      pluginInstanceId,
      pins: { ...(this.pins.get(pluginInstanceId) ?? {}) },
    }))
  }

  async read(
    auth: SignedControlPlaneAuth,
    input: { pluginInstanceId: string; harnessId: AgentPluginHarnessId; projectId?: string },
  ): Promise<SignedActivationSnapshot> {
    if (input.projectId) await this.authorizeProject(auth, input.projectId)
    const userDefault = this.userDefaults.get(mapKey(this.subject(auth), input.pluginInstanceId, input.harnessId))
    const projectOverride = input.projectId
      ? this.projectOverrides.get(mapKey(this.subject(auth), input.projectId, input.pluginInstanceId, input.harnessId))
      : undefined
    const organizationDefault = this.organizationDefaults.has(mapKey(this.org(auth), input.pluginInstanceId, input.harnessId))
    const pins = this.pins.get(input.pluginInstanceId) ?? {}
    return {
      revision: this.currentRevision,
      pluginInstanceId: input.pluginInstanceId,
      harnessId: input.harnessId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(projectOverride !== undefined ? { projectOverride } : {}),
      ...(userDefault !== undefined ? { userDefault } : {}),
      ...(organizationDefault ? { organizationDefault: true as const } : {}),
      pins: {
        ...(pins.user ? { user: pins.user.digest } : {}),
        ...(pins.organization ? { organization: pins.organization.digest } : {}),
        ...(pins.claxedo ? { claxedo: pins.claxedo.digest } : {}),
      },
    }
  }

  async mutateUser(auth: SignedControlPlaneAuth, input: MutateSignedUserActivation) {
    this.checkRevision(input.expectedRevision)
    const harnesses = this.supported(input.harnessIds)
    if (input.target.scope === "projects") {
      for (const projectId of input.target.projectIds) await this.authorizeProject(auth, projectId)
    }
    const pin = this.writablePin(input.pluginInstanceId)
    if (input.artifact) pin.user = input.artifact
    if (input.choice === true && !pin.user) {
      throw new AgentPluginActivationStoreError("artifact-unavailable", "User artifact is unavailable")
    }
    for (const harnessId of harnesses) {
      if (input.target.scope === "all-projects") {
        const key = mapKey(this.subject(auth), input.pluginInstanceId, harnessId)
        if (input.choice === undefined) this.userDefaults.delete(key)
        else this.userDefaults.set(key, input.choice)
      } else {
        for (const projectId of input.target.projectIds) {
          const key = mapKey(this.subject(auth), projectId, input.pluginInstanceId, harnessId)
          if (input.choice === undefined) this.projectOverrides.delete(key)
          else this.projectOverrides.set(key, input.choice)
        }
      }
    }
    return ++this.currentRevision
  }

  async mutateOrganizationDefault(auth: SignedControlPlaneAuth, input: MutateSignedOrganizationDefault) {
    this.checkRevision(input.expectedRevision)
    if (this.subject(auth) !== "admin") {
      throw new ControlPlaneAuthError(403, "workspace_authorization_denied", "Organization admin access required")
    }
    const harnesses = this.supported(input.harnessIds)
    const pin = this.writablePin(input.pluginInstanceId)
    if (input.artifact) pin.organization = input.artifact
    if (input.choice === true && !pin.organization) {
      throw new AgentPluginActivationStoreError("artifact-unavailable", "Organization artifact is unavailable")
    }
    for (const harnessId of harnesses) {
      const key = mapKey(this.org(auth), input.pluginInstanceId, harnessId)
      if (input.choice === true) this.organizationDefaults.add(key)
      else this.organizationDefaults.delete(key)
    }
    return ++this.currentRevision
  }

  async updateUserArtifact(_auth: SignedControlPlaneAuth, input: UpdateSignedArtifactPin) {
    this.checkRevision(input.expectedRevision)
    const pin = this.writablePin(input.pluginInstanceId)
    if (!pin.user) throw new AgentPluginActivationStoreError("artifact-unavailable", "User pin does not exist")
    pin.user = input.artifact
    return ++this.currentRevision
  }

  async updateOrganizationArtifact(auth: SignedControlPlaneAuth, input: UpdateSignedArtifactPin) {
    this.checkRevision(input.expectedRevision)
    if (this.subject(auth) !== "admin") {
      throw new ControlPlaneAuthError(403, "workspace_authorization_denied", "Organization admin access required")
    }
    const pin = this.writablePin(input.pluginInstanceId)
    if (!pin.organization) throw new AgentPluginActivationStoreError("artifact-unavailable", "Organization pin does not exist")
    pin.organization = input.artifact
    return ++this.currentRevision
  }
}

async function fixture(options: {
  mcp?: boolean
  mcpAuthentication?: AgentPluginMcpCatalogAuthenticationResolver
  mcpClientMetadata?: ReturnType<typeof hostedMcpClientMetadata>
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-hosted-agent-plugins-"))
  roots.push(root)
  const collection = path.join(root, "collection")
  const plugin = path.join(collection, "review")
  await fs.mkdir(plugin, { recursive: true })
  await fs.writeFile(path.join(plugin, "plugin.json"), JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "review",
    version: "1.0.0",
  }))
  await fs.writeFile(path.join(plugin, "marker.txt"), "version one")
  if (options.mcp) {
    await fs.writeFile(path.join(plugin, "mcp.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { docs: { type: "streamable-http", url: "https://mcp.example/docs" } },
    }))
  }

  const sources: CatalogSourceProvider = {
    async listAuthorizedSources() {
      return [await fileSystemCollectionSource({ id: "org-collection", kind: "organization", label: "Team", revision: "main" }, collection)]
    },
  }
  const usersMe = vi.fn(async () => ({ user_id: "user-main", org_id: "org-main" }))
  const services = {
    auth: {
      config: { enabled: true, issuer: "https://auth.test", jwksUrl: "https://auth.test/jwks" },
      verifier: vi.fn(async (token: string) => ({
        mode: "signed" as const,
        user: {
          subject: token,
          tokenIdentifier: `https://auth.test|${token}`,
          issuer: "https://auth.test",
          orgId: "org-main",
        },
      })),
    },
    authority: {
      usersMe,
      listWorkspaces: vi.fn(async () => []),
      listOrgs: vi.fn(async (auth: SignedControlPlaneAuth) => [{
        clerk_org_id: "org-main",
        role: auth.user.subject === "admin" ? "admin" : "member",
      }]),
    },
    telemetry: { capture: vi.fn() },
  } as unknown as ControlPlaneServices
  const activations = new MemorySignedActivations()
  const artifacts = new MemoryArtifacts()
  const reconcile = { reconcile: vi.fn(async () => ({ state: "applied" as const })) }
  const app = HostedAgentPluginRoutes({
    services,
    sources: () => sources,
    activations,
    artifacts,
    reconcile,
    ...(options.mcpAuthentication ? { mcpAuthentication: options.mcpAuthentication } : {}),
    ...(options.mcpClientMetadata ? { mcpClientMetadata: options.mcpClientMetadata } : {}),
  })
  return { app, collection, plugin, activations, artifacts, reconcile, usersMe }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function request(app: ReturnType<typeof HostedAgentPluginRoutes>, pathName: string, token = "member", init?: RequestInit) {
  return await app.request(`http://control.test${pathName}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  })
}

describe("hosted Agent Plugins routes", () => {
  test("establishes the canonical authority user before reading activation state", async () => {
    const subject = await fixture()
    let principalReady = false
    subject.usersMe.mockImplementationOnce(async () => {
      principalReady = true
      return { user_id: "user-main", org_id: "org-main" }
    })
    const revision = vi.spyOn(subject.activations, "revision").mockImplementation(async () => {
      expect(principalReady).toBe(true)
      return 0
    })

    const response = await request(subject.app, "/")

    expect(response.status).toBe(200)
    expect(subject.usersMe).toHaveBeenCalledOnce()
    expect(revision).toHaveBeenCalled()
  })

  test("serves Client ID Metadata publicly with an exact self-identifying client ID", async () => {
    const metadata = hostedMcpClientMetadata("https://control.example.com")
    const subject = await fixture({ mcpClientMetadata: metadata })

    const response = await subject.app.request(`http://control.test${metadata.route}`)

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600")
    expect(await response.json()).toEqual(metadata.document)
  })

  test("projects MCP authentication state without exposing connection or credential metadata", async () => {
    const mcpAuthentication = vi.fn<AgentPluginMcpCatalogAuthenticationResolver>(async ({ pluginInstanceId, server }) => ({
      state: "oauth",
      integrationId: `${pluginInstanceId}:${server.name}`,
    }))
    const subject = await fixture({ mcp: true, mcpAuthentication })
    const catalog = await (await request(subject.app, "/")).json() as any

    expect(catalog.candidates[0].mcpServers).toEqual([{
      name: "docs",
      type: "streamable-http",
      authentication: {
        state: "oauth",
        integrationId: `${catalog.candidates[0].pluginInstanceId}:docs`,
      },
    }])
    expect(JSON.stringify(catalog)).not.toContain("token")
    expect(JSON.stringify(catalog)).not.toContain("connectionId")
  })

  test("applies a dynamic all-projects default while an explicit project disable wins", async () => {
    const subject = await fixture()
    expect((await subject.app.request("http://control.test/projects/project-a")).status).toBe(401)
    const defaults = await request(subject.app, "/")
    expect(defaults.status).toBe(200)
    expect(await defaults.json()).toMatchObject({
      selectedProjectId: null,
      canManageOrganizationDefaults: false,
      canManageOrganizationConnections: false,
    })
    expect((await request(subject.app, "/projects/forbidden")).status).toBe(403)

    const first = await request(subject.app, "/projects/project-a")
    expect(first.status).toBe(200)
    const firstBody = await first.json() as any
    const plugin = firstBody.candidates[0]

    let response = await request(subject.app, "/activation", "member", {
      method: "POST",
      body: JSON.stringify({
        pluginInstanceId: plugin.pluginInstanceId,
        harnessIds: ["codex", "cursor"],
        choice: true,
        expectedRevision: 0,
        target: { scope: "all-projects" },
      }),
    })
    expect(response.status).toBe(200)
    expect(subject.artifacts.values.size).toBe(1)

    const future = await (await request(subject.app, "/projects/future-project")).json() as any
    expect(future.candidates[0].harnesses.codex).toMatchObject({
      projectOverride: null,
      userDefault: true,
      effective: { effective: true, winner: "user-default", status: "ready" },
    })

    response = await request(subject.app, "/activation", "member", {
      method: "POST",
      body: JSON.stringify({
        pluginInstanceId: plugin.pluginInstanceId,
        harnessIds: ["codex"],
        choice: false,
        expectedRevision: 1,
        target: { scope: "projects", projectIds: ["project-a"] },
      }),
    })
    expect(response.status).toBe(200)
    const current = await (await request(subject.app, "/projects/project-a")).json() as any
    expect(current.candidates[0].harnesses.codex).toMatchObject({
      projectOverride: false,
      userDefault: true,
      effective: { effective: false, winner: "project" },
    })
    const stillFuture = await (await request(subject.app, "/projects/future-project")).json() as any
    expect(stillFuture.candidates[0].harnesses.codex.effective.effective).toBe(true)
  })

  test("authorizes an entire project batch before writing and never accepts caller owner IDs", async () => {
    const subject = await fixture()
    const catalog = await (await request(subject.app, "/projects/project-a")).json() as any
    const pluginInstanceId = catalog.candidates[0].pluginInstanceId

    let response = await request(subject.app, "/activation", "member", {
      method: "POST",
      body: JSON.stringify({
        pluginInstanceId,
        harnessIds: ["claude"],
        choice: true,
        expectedRevision: 0,
        target: { scope: "projects", projectIds: ["project-a", "forbidden"] },
      }),
    })
    expect(response.status).toBe(403)
    expect(await subject.activations.revision()).toBe(0)

    response = await request(subject.app, "/activation", "member", {
      method: "POST",
      body: JSON.stringify({
        pluginInstanceId,
        harnessIds: ["claude"],
        choice: true,
        expectedRevision: 0,
        ownerUserId: "another-user",
        target: { scope: "projects", projectIds: ["project-a"] },
      }),
    })
    expect(response.status).toBe(400)
    expect(await subject.activations.revision()).toBe(0)
  })

  test("keeps retained metadata usable after the collection disappears and updates only explicitly", async () => {
    const subject = await fixture()
    const first = await (await request(subject.app, "/projects/project-a")).json() as any
    const plugin = first.candidates[0]
    await request(subject.app, "/activation", "member", {
      method: "POST",
      body: JSON.stringify({
        pluginInstanceId: plugin.pluginInstanceId,
        harnessIds: ["opencode"],
        choice: true,
        expectedRevision: 0,
        target: { scope: "all-projects" },
      }),
    })
    await fs.writeFile(path.join(subject.plugin, "marker.txt"), "version two")
    const refreshed = await (await request(subject.app, "/projects/project-a/refresh")).json() as any
    expect(refreshed.revision).toBe(1)
    expect(refreshed.candidates[0]).toMatchObject({ updateAvailable: true, sourceAvailable: true })
    expect(subject.reconcile.reconcile).toHaveBeenCalledTimes(1)

    let response = await request(subject.app, "/update", "member", {
      method: "POST",
      body: JSON.stringify({ pluginInstanceId: plugin.pluginInstanceId, authority: "user", expectedRevision: 1 }),
    })
    expect(response.status).toBe(200)
    const updateBody = await response.json() as any
    expect(updateBody.revision).toBe(2)
    const afterUpdate = await (await request(subject.app, "/projects/project-a")).json() as any
    expect(afterUpdate.candidates[0]).toMatchObject({ updateAvailable: false })
    expect(afterUpdate.candidates[0].harnesses.opencode.effective.effective).toBe(true)

    await fs.rm(subject.collection, { recursive: true })
    const gone = await (await request(subject.app, "/projects/project-a/refresh")).json() as any
    expect(gone.candidates).toHaveLength(1)
    expect(gone.candidates[0]).toMatchObject({
      pluginInstanceId: plugin.pluginInstanceId,
      sourceAvailable: false,
      artifactAvailable: true,
    })
    expect(gone.candidates[0].harnesses.opencode.effective.effective).toBe(true)
  })

  test("allows only an admin and a non-personal source to write or update an organization default", async () => {
    const subject = await fixture()
    const adminCatalog = await (await request(subject.app, "/", "admin")).json() as any
    expect(adminCatalog).toMatchObject({
      canManageOrganizationDefaults: true,
      canManageOrganizationConnections: true,
    })
    const first = await (await request(subject.app, "/projects/project-a")).json() as any
    const pluginInstanceId = first.candidates[0].pluginInstanceId

    let response = await request(subject.app, "/organization-default", "member", {
      method: "POST",
      body: JSON.stringify({ pluginInstanceId, harnessIds: ["codex"], choice: true, expectedRevision: 0 }),
    })
    expect(response.status).toBe(403)
    expect(await subject.activations.revision()).toBe(0)

    response = await request(subject.app, "/organization-default", "admin", {
      method: "POST",
      body: JSON.stringify({ pluginInstanceId, harnessIds: ["codex"], choice: false, expectedRevision: 0 }),
    })
    expect(response.status).toBe(400)

    response = await request(subject.app, "/organization-default", "admin", {
      method: "POST",
      body: JSON.stringify({ pluginInstanceId, harnessIds: ["codex"], choice: true, expectedRevision: 0 }),
    })
    expect(response.status).toBe(200)
    expect(await subject.activations.revision()).toBe(1)

    response = await request(subject.app, "/update", "member", {
      method: "POST",
      body: JSON.stringify({ pluginInstanceId, authority: "organization", expectedRevision: 1 }),
    })
    expect(response.status).toBe(403)
    expect(await subject.activations.revision()).toBe(1)
  })
})
