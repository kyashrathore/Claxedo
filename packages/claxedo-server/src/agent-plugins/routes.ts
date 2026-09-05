import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import { Hono, type Context } from "hono"
import { acquirePluginArtifact } from "@claxedo/server-core/agent-plugins/artifacts/acquire"
import type { AgentPluginArtifactStore } from "@claxedo/server-core/agent-plugins/artifacts/types"
import { resolveEffectiveActivation } from "@claxedo/server-core/agent-plugins/activation/effective"
import type {
  AgentPluginArtifactPin,
  MutateSignedOrganizationDefault,
  MutateSignedUserActivation,
  SignedAgentPluginActivationStore,
  SignedKnownPlugin,
  UpdateSignedArtifactPin,
} from "@claxedo/server-core/agent-plugins/activation/store"
import { AgentPluginActivationStoreError } from "@claxedo/server-core/agent-plugins/activation/store"
import { resolveCollections } from "@claxedo/server-core/agent-plugins/catalog/resolve-collections"
import {
  candidatePresentation,
  retainedPresentation,
} from "@claxedo/server-core/agent-plugins/catalog/presentation"
import { readRetainedSkill } from "@claxedo/server-core/agent-plugins/catalog/read-skill"
import type { AgentPluginCatalogCandidate } from "@claxedo/server-core/agent-plugins/catalog/types"
import type { ValidatedAgentPlugin } from "@claxedo/server-core/agent-plugins/catalog/types"
import type { AgentPluginReconcilePort, CatalogSourceProvider } from "@claxedo/server-core/agent-plugins/ports"
import {
  SUPPORTED_AGENT_PLUGIN_HARNESSES,
  isAgentPluginHarnessId,
  type AgentPluginHarnessId,
} from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { controlPlaneAuthErrorBody, ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../authority/services"
import { signedOrError } from "../workspace/route-support"
import type { AgentPluginMcpCatalogAuthenticationResolver } from "./mcp/catalog-auth"
import { createRequestTiming } from "./request-timing"
import type { HostedMcpClientMetadata } from "./mcp/client-metadata"
import type { AgentPluginSelfRuntimeReader } from "./runtime/self-runtime"

type SignedSources = (auth: SignedControlPlaneAuth) => CatalogSourceProvider

function error(code: string, message: string) {
  return { error: { code, message } }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function harnesses(value: unknown): AgentPluginHarnessId[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isAgentPluginHarnessId)) return undefined
  return [...new Set(value)]
}

function expectedRevision(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined
  return value
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const allowed = new Set(keys)
  return Object.keys(value).every((key) => allowed.has(key))
}

function userMutation(value: unknown): Omit<MutateSignedUserActivation, "artifact"> | undefined {
  if (!record(value) || typeof value.pluginInstanceId !== "string" || !value.pluginInstanceId) return undefined
  if (!hasOnlyKeys(value, ["pluginInstanceId", "harnessIds", "choice", "expectedRevision", "target"])) return undefined
  const selectedHarnesses = harnesses(value.harnessIds)
  const revision = expectedRevision(value.expectedRevision)
  const target = record(value.target) ? value.target : undefined
  const choice = value.choice === null ? undefined : value.choice
  if (!selectedHarnesses || revision === undefined || (choice !== true && choice !== false && choice !== undefined)) return undefined
  if (target?.scope === "all-projects") {
    if (!hasOnlyKeys(target, ["scope"])) return undefined
    return { pluginInstanceId: value.pluginInstanceId, harnessIds: selectedHarnesses, choice, expectedRevision: revision, target: { scope: "all-projects" as const } }
  }
  if (target?.scope !== "projects"
    || !hasOnlyKeys(target, ["scope", "projectIds"])
    || !Array.isArray(target.projectIds)
    || target.projectIds.length === 0
    || !target.projectIds.every((item): item is string => typeof item === "string" && Boolean(item.trim()))) return undefined
  return {
    pluginInstanceId: value.pluginInstanceId,
    harnessIds: selectedHarnesses,
    choice,
    expectedRevision: revision,
    target: { scope: "projects" as const, projectIds: [...new Set(target.projectIds)] },
  }
}

function organizationMutation(value: unknown): Omit<MutateSignedOrganizationDefault, "artifact"> | undefined {
  if (!record(value) || typeof value.pluginInstanceId !== "string" || !value.pluginInstanceId) return undefined
  if (!hasOnlyKeys(value, ["pluginInstanceId", "harnessIds", "choice", "expectedRevision"])) return undefined
  const selectedHarnesses = harnesses(value.harnessIds)
  const revision = expectedRevision(value.expectedRevision)
  if (value.choice !== true && value.choice !== null) return undefined
  const choice: true | undefined = value.choice === true ? true : undefined
  if (!selectedHarnesses || revision === undefined) return undefined
  return { pluginInstanceId: value.pluginInstanceId, harnessIds: selectedHarnesses, choice, expectedRevision: revision }
}

function updateMutation(value: unknown): Omit<UpdateSignedArtifactPin, "artifact"> & { authority: "user" | "organization" } | undefined {
  if (!record(value)
    || !hasOnlyKeys(value, ["pluginInstanceId", "authority", "expectedRevision"])
    || typeof value.pluginInstanceId !== "string"
    || !value.pluginInstanceId
    || (value.authority !== "user" && value.authority !== "organization")) return undefined
  const revision = expectedRevision(value.expectedRevision)
  if (revision === undefined) return undefined
  return { pluginInstanceId: value.pluginInstanceId, authority: value.authority, expectedRevision: revision }
}

async function currentCandidate(sources: SignedSources, auth: SignedControlPlaneAuth, pluginInstanceId: string) {
  const catalog = await resolveCollections(sources(auth), { fresh: true })
  return catalog.candidates.find((candidate) => candidate.pluginInstanceId === pluginInstanceId)
}

function pin(candidate: AgentPluginCatalogCandidate, digest: AgentPluginArtifactPin["digest"]): AgentPluginArtifactPin {
  return {
    digest,
    sourceId: candidate.sourceId,
    relativePath: candidate.relativePath,
    sourceRevision: candidate.sourceRevision,
  }
}

async function mcpServerViews(input: {
  pluginInstanceId: string
  mcp: ValidatedAgentPlugin["mcp"]
  authentication?: AgentPluginMcpCatalogAuthenticationResolver
}) {
  if (input.mcp.status !== "valid") return []
  return Promise.all(input.mcp.servers.map(async (server) => {
    if (server.type === "stdio") return { name: server.name, type: server.type, authentication: { state: "local" as const } }
    if (server.type === "sse") {
      return { name: server.name, type: server.type, authentication: { state: "unavailable" as const, reason: "mcp_transport_unsupported" } }
    }
    const authentication = input.authentication
      ? await input.authentication({ pluginInstanceId: input.pluginInstanceId, server })
      : { state: "unavailable" as const, reason: "mcp_auth_management_unavailable" }
    return { name: server.name, type: server.type, authentication }
  }))
}

/**
 * Organization defaults and organization Connections are admin surfaces. The
 * authority reports the caller's role per organization; a single-org product
 * (user-deployed) has exactly one row, a multi-org product resolves the one
 * the caller is acting in the same way the activation store does.
 */
async function canManageOrganization(input: {
  services: ControlPlaneServices
  auth: SignedControlPlaneAuth
  me: unknown
}) {
  if (!input.services.authority) return false
  const orgId = record(input.me) && typeof input.me.org_id === "string"
    ? input.me.org_id
    : await input.services.authority.resolveOrgId(input.auth).catch(() => undefined)
  if (!orgId) return false
  const result = await input.services.authority.listOrgs(input.auth)
  if (!Array.isArray(result)) return false
  return result.some((value) => {
    if (!record(value)) return false
    return value.org_id === orgId && (value.role === "admin" || value.role === "owner")
  })
}

async function candidateView(input: {
  candidate: AgentPluginCatalogCandidate
  /** The caller's retained plugins, read once per request by the catalog. */
  known: SignedKnownPlugin[]
  auth: SignedControlPlaneAuth
  projectId?: string
  activations: SignedAgentPluginActivationStore
  artifacts: AgentPluginArtifactStore
  mcpAuthentication?: AgentPluginMcpCatalogAuthenticationResolver
}) {
  const states = await Promise.all(SUPPORTED_AGENT_PLUGIN_HARNESSES.map(async (harnessId) => {
    const snapshot = await input.activations.read(input.auth, {
      pluginInstanceId: input.candidate.pluginInstanceId,
      harnessId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
    })
    return [harnessId, {
      projectOverride: snapshot.projectOverride ?? null,
      userDefault: snapshot.userDefault ?? null,
      organizationDefault: snapshot.organizationDefault ?? false,
      claxedoDefault: snapshot.claxedoDefault ?? false,
      effective: resolveEffectiveActivation({
        mode: "signed",
        pluginInstanceId: snapshot.pluginInstanceId,
        harnessId,
        projectOverride: snapshot.projectOverride,
        userDefault: snapshot.userDefault,
        organizationDefault: snapshot.organizationDefault,
        claxedoDefault: snapshot.claxedoDefault,
        pins: snapshot.pins,
      }),
    }] as const
  }))
  const known = input.known.find((item) => item.pluginInstanceId === input.candidate.pluginInstanceId)
  const retained = known?.pins.user ?? known?.pins.organization ?? known?.pins.claxedo
  let retainedArtifact: Awaited<ReturnType<AgentPluginArtifactStore["get"]>>
  let artifactError: string | undefined
  try {
    retainedArtifact = retained ? await input.artifacts.get(retained.digest) : undefined
  } catch (cause) {
    artifactError = cause instanceof Error ? cause.message : "Retained plugin artifact is unreadable"
  }
  return {
    pluginInstanceId: input.candidate.pluginInstanceId,
    sourceId: input.candidate.sourceId,
    sourceKind: input.candidate.sourceKind,
    ...candidatePresentation({ candidate: input.candidate, retained: retainedArtifact?.plugin }),
    sourceRevision: input.candidate.sourceRevision,
    relativePath: input.candidate.relativePath,
    candidateDigest: input.candidate.artifactDigest,
    retainedDigest: retained?.digest ?? null,
    artifactAvailable: retained ? Boolean(retainedArtifact) : undefined,
    ...(artifactError ? { artifactError } : {}),
    sourceAvailable: true,
    updateAvailable: Boolean(retained && retained.digest !== input.candidate.artifactDigest),
    manifest: input.candidate.manifest,
    mcpServers: await mcpServerViews({
      pluginInstanceId: input.candidate.pluginInstanceId,
      mcp: retainedArtifact?.plugin.mcp ?? input.candidate.mcp,
      ...(input.mcpAuthentication ? { authentication: input.mcpAuthentication } : {}),
    }),
    componentDiagnostics: input.candidate.componentDiagnostics,
    harnesses: Object.fromEntries(states),
  }
}

async function retainedView(input: {
  known: SignedKnownPlugin
  auth: SignedControlPlaneAuth
  projectId?: string
  activations: SignedAgentPluginActivationStore
  artifacts: AgentPluginArtifactStore
  mcpAuthentication?: AgentPluginMcpCatalogAuthenticationResolver
}) {
  const retainedPin = input.known.pins.user ?? input.known.pins.organization ?? input.known.pins.claxedo
  let retained: Awaited<ReturnType<AgentPluginArtifactStore["get"]>>
  let artifactError: string | undefined
  try {
    retained = retainedPin ? await input.artifacts.get(retainedPin.digest) : undefined
  } catch (cause) {
    artifactError = cause instanceof Error ? cause.message : "Retained plugin artifact is unreadable"
  }
  const states = await Promise.all(SUPPORTED_AGENT_PLUGIN_HARNESSES.map(async (harnessId) => {
    const snapshot = await input.activations.read(input.auth, {
      pluginInstanceId: input.known.pluginInstanceId,
      harnessId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
    })
    return [harnessId, {
      projectOverride: snapshot.projectOverride ?? null,
      userDefault: snapshot.userDefault ?? null,
      organizationDefault: snapshot.organizationDefault ?? false,
      claxedoDefault: snapshot.claxedoDefault ?? false,
      effective: resolveEffectiveActivation({
        mode: "signed",
        pluginInstanceId: snapshot.pluginInstanceId,
        harnessId,
        projectOverride: snapshot.projectOverride,
        userDefault: snapshot.userDefault,
        organizationDefault: snapshot.organizationDefault,
        claxedoDefault: snapshot.claxedoDefault,
        pins: snapshot.pins,
      }),
    }] as const
  }))
  return {
    pluginInstanceId: input.known.pluginInstanceId,
    sourceId: retainedPin?.sourceId ?? null,
    sourceKind: null,
    ...retainedPresentation(retained?.plugin),
    sourceRevision: retainedPin?.sourceRevision ?? null,
    relativePath: retainedPin?.relativePath ?? null,
    candidateDigest: null,
    retainedDigest: retainedPin?.digest ?? null,
    artifactAvailable: Boolean(retained),
    ...(artifactError ? { artifactError } : {}),
    sourceAvailable: false,
    updateAvailable: false,
    manifest: retained?.plugin.manifest ?? null,
    mcpServers: retained
      ? await mcpServerViews({
          pluginInstanceId: input.known.pluginInstanceId,
          mcp: retained.plugin.mcp,
          ...(input.mcpAuthentication ? { authentication: input.mcpAuthentication } : {}),
        })
      : [],
    componentDiagnostics: [],
    harnesses: Object.fromEntries(states),
  }
}

/** Signed personal/project and organization-default Agent Plugins API. */
export function HostedAgentPluginRoutes(input: {
  services: ControlPlaneServices
  /**
   * The deployment's request-authentication adapter. Better Auth + D1 planes
   * authenticate through it and compose no token verifier, so a route that
   * only knew `services.auth.verifier` answered every signed caller with
   * `auth_verifier_unavailable`.
   */
  authentication?: RequestAuthenticationAdapter
  sources: SignedSources
  artifacts: AgentPluginArtifactStore
  activations: SignedAgentPluginActivationStore
  reconcile: AgentPluginReconcilePort
  mcpAuthentication?: AgentPluginMcpCatalogAuthenticationResolver
  mcpClientMetadata?: HostedMcpClientMetadata
  /** The signed user's own runtime world for a machine they own; absent in compositions without one. */
  selfRuntime?: AgentPluginSelfRuntimeReader
}) {
  const app = new Hono()
  const authenticate = async (request: Request) => {
    const result = await signedOrError(request, {
      ...(input.authentication ? { authentication: input.authentication } : {}),
      authConfig: input.services.auth.config,
      ...(input.services.auth.verifier ? { verifier: input.services.auth.verifier } : {}),
      requireSigned: true,
    }, input.services)
    if (!result.auth) {
      if (result.error) return { error: result.error, status: result.status ?? 401 }
      // `requireSigned` answers a missing bearer with an error above; an
      // absent auth without one is a posture bug, not a client mistake.
      throw new ControlPlaneAuthError(401, "missing_bearer_token", "Signed auth is required")
    }
    if (!input.services.authority) {
      throw new ControlPlaneAuthError(
        503,
        "workspace_authority_unavailable",
        "Agent Plugins requires the workspace authority",
      )
    }
    const me: unknown = await input.services.authority.usersMe(result.auth)
    return { auth: result.auth, me }
  }
  const apply = async (revision: number) => {
    try {
      return await input.reconcile.reconcile(revision)
    } catch (cause) {
      return { state: "failed" as const, message: cause instanceof Error ? cause.message : "Agent Plugins reconciliation failed" }
    }
  }

  app.onError((cause, c) => {
    if (cause instanceof ControlPlaneAuthError) {
      return c.json(controlPlaneAuthErrorBody(cause), cause.status)
    }
    if (cause instanceof AgentPluginActivationStoreError) {
      const status = cause.code === "revision-conflict" ? 409 : 400
      return c.json(error(`agent_plugins_${cause.code.replaceAll("-", "_")}`, cause.message), status)
    }
    throw cause
  })

  const clientMetadata = input.mcpClientMetadata
  if (clientMetadata) {
    app.get(clientMetadata.route, (c) => c.json(
      clientMetadata.document,
      200,
      { "cache-control": "public, max-age=3600" },
    ))
  }

  const catalog = async (c: Context, options: { fresh: boolean; projectId?: string }) => {
    const timing = createRequestTiming()
    const authResult = await authenticate(c.req.raw)
    if ("error" in authResult || !authResult.auth) return c.json("error" in authResult ? authResult.error : error("missing_bearer_token", "Signed auth is required"), "status" in authResult ? authResult.status : 401)
    const auth = authResult.auth
    const projectId = options.projectId?.trim()
    if (projectId) await input.activations.authorizeProject(auth, projectId)
    timing.mark("auth")
    const before = await input.activations.revision(auth)
    timing.mark("revision")
    const resolved = await resolveCollections(input.sources(auth), { fresh: options.fresh })
    timing.mark("sources")
    // The source listing must not have moved activation state; the rest of
    // the read is independent of it, so those reads share one wait.
    const [after, known, workspaceResult, organizationManager] = await Promise.all([
      input.activations.revision(auth),
      input.activations.listKnown(auth),
      input.services.authority?.listWorkspaces(auth),
      canManageOrganization({ services: input.services, auth, me: authResult.me }),
    ])
    if (before !== after) throw new Error("Catalog reads must not mutate Agent Plugins activation state")
    timing.mark("state")
    const candidateIds = new Set(resolved.candidates.map((candidate) => candidate.pluginInstanceId))
    const [candidates, retained] = await Promise.all([
      Promise.all(resolved.candidates.map((candidate) => candidateView({
        candidate,
        known,
        auth,
        projectId,
        activations: input.activations,
        artifacts: input.artifacts,
        ...(input.mcpAuthentication ? { mcpAuthentication: input.mcpAuthentication } : {}),
      }))),
      Promise.all(known
        .filter((entry) => !candidateIds.has(entry.pluginInstanceId))
        .map((entry) => retainedView({
          known: entry,
          auth,
          projectId,
          activations: input.activations,
          artifacts: input.artifacts,
          ...(input.mcpAuthentication ? { mcpAuthentication: input.mcpAuthentication } : {}),
        }))),
    ])
    timing.mark("views")
    timing.report(options.fresh ? "catalog.refresh" : "catalog", {
      candidates: candidates.length,
      retained: retained.length,
      project: Boolean(projectId),
    })
    const workspaces: unknown[] = Array.isArray(workspaceResult) ? workspaceResult : []
    const projects = [...new Map<string, { id: string; label: string }>(workspaces.flatMap((workspace) => {
      if (!record(workspace)) return []
      const id = typeof workspace.project_id === "string" ? workspace.project_id : undefined
      if (!id) return []
      const label = typeof workspace.project_name === "string" && workspace.project_name.trim()
        ? workspace.project_name
        : id
      return [[id, { id, label }] as const]
    })).values()].toSorted((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id))
    return c.json({
      revision: after,
      canManageOrganizationDefaults: organizationManager,
      canManageOrganizationConnections: organizationManager,
      supportedHarnesses: SUPPORTED_AGENT_PLUGIN_HARNESSES,
      projects,
      selectedProjectId: projectId ?? null,
      candidates: [...candidates, ...retained],
      errors: resolved.errors,
    })
  }

  app.get("/", (c) => catalog(c, { fresh: false }))
  app.get("/refresh", (c) => catalog(c, { fresh: true }))

  // The signed desktop's pull: everything the user's own machine must
  // materialize, plus the gateway credentials a sandbox driver would have
  // brokered. Authenticated exactly like the catalog; the response is the
  // VM apply request shape so the desktop reuses the one materializer.
  if (input.selfRuntime) {
    const selfRuntime = input.selfRuntime
    app.get("/runtime/self", async (c) => {
      const timing = createRequestTiming()
      const authResult = await authenticate(c.req.raw)
      if ("error" in authResult || !authResult.auth) return c.json("error" in authResult ? authResult.error : error("missing_bearer_token", "Signed auth is required"), "status" in authResult ? authResult.status : 401)
      timing.mark("auth")
      const runtime = await selfRuntime(authResult.auth, timing)
      timing.report("runtime.self", { selections: runtime.selections.length, mcpServers: runtime.mcpServers.length })
      return c.json(runtime, 200, { "cache-control": "no-store" })
    })
  }
  app.get("/projects/:projectId", (c) => catalog(c, { fresh: false, projectId: c.req.param("projectId") }))
  app.get("/projects/:projectId/refresh", (c) => catalog(c, { fresh: true, projectId: c.req.param("projectId") }))

  /**
   * One skill's SKILL.md, read from the retained artifact tree. A source read
   * would show the caller text their runtime does not run, so a plugin with no
   * retained artifact has no readable skill. The project prefix authorizes the
   * project the way the catalog does and selects nothing else: retained
   * artifacts are user- and organization-scoped, never project-scoped.
   */
  const skill = async (c: Context, options: { projectId?: string }) => {
    const authResult = await authenticate(c.req.raw)
    if ("error" in authResult || !authResult.auth) return c.json("error" in authResult ? authResult.error : error("missing_bearer_token", "Signed auth is required"), "status" in authResult ? authResult.status : 401)
    const auth = authResult.auth
    const projectId = options.projectId?.trim()
    if (projectId) await input.activations.authorizeProject(auth, projectId)
    const known = (await input.activations.listKnown(auth))
      .find((item) => item.pluginInstanceId === c.req.param("pluginInstanceId"))
    const retainedPin = known?.pins.user ?? known?.pins.organization ?? known?.pins.claxedo
    const retained = retainedPin ? await input.artifacts.get(retainedPin.digest) : undefined
    const document = readRetainedSkill(retained, c.req.param("skill"))
    if (!document) {
      return c.json(error("agent_plugins_skill_not_found", "No retained artifact serves this skill"), 404)
    }
    return c.json(document)
  }
  app.get("/:pluginInstanceId/skills/:skill", (c) => skill(c, {}))
  app.get(
    "/projects/:projectId/:pluginInstanceId/skills/:skill",
    (c) => skill(c, { projectId: c.req.param("projectId") }),
  )

  app.post("/activation", async (c) => {
    const authResult = await authenticate(c.req.raw)
    if ("error" in authResult || !authResult.auth) return c.json("error" in authResult ? authResult.error : error("missing_bearer_token", "Signed auth is required"), "status" in authResult ? authResult.status : 401)
    const auth = authResult.auth
    const body = userMutation(await c.req.json().catch(() => undefined))
    if (!body) return c.json(error("agent_plugins_invalid_body", "Invalid signed Agent Plugins activation request"), 400)
    const known = (await input.activations.listKnown(auth)).find((item) => item.pluginInstanceId === body.pluginInstanceId)
    let revision: number | undefined
    if (body.choice === true && !known?.pins.user) {
      const candidate = await currentCandidate(input.sources, auth, body.pluginInstanceId)
      if (!candidate) return c.json(error("agent_plugins_candidate_unavailable", "Plugin is not available in the current catalog"), 409)
      await acquirePluginArtifact({
        tree: candidate.tree,
        store: input.artifacts,
        commit: async (artifact) => {
          revision = await input.activations.mutateUser(auth, { ...body, artifact: pin(candidate, artifact.digest) })
        },
      })
    } else {
      revision = await input.activations.mutateUser(auth, body)
    }
    const reconciliation = await apply(revision!)
    return c.json({ revision, reconciliation }, reconciliation.state === "failed" ? 202 : 200)
  })

  app.post("/organization-default", async (c) => {
    const authResult = await authenticate(c.req.raw)
    if ("error" in authResult || !authResult.auth) return c.json("error" in authResult ? authResult.error : error("missing_bearer_token", "Signed auth is required"), "status" in authResult ? authResult.status : 401)
    const auth = authResult.auth
    const body = organizationMutation(await c.req.json().catch(() => undefined))
    if (!body) return c.json(error("agent_plugins_invalid_body", "Organization defaults accept only true or return-to-default"), 400)
    const known = (await input.activations.listKnown(auth)).find((item) => item.pluginInstanceId === body.pluginInstanceId)
    let revision: number | undefined
    if (body.choice === true && !known?.pins.organization) {
      const candidate = await currentCandidate(input.sources, auth, body.pluginInstanceId)
      if (!candidate) return c.json(error("agent_plugins_candidate_unavailable", "Plugin is not available in the current catalog"), 409)
      if (candidate.sourceKind === "personal") {
        return c.json(error("agent_plugins_organization_source_required", "Organization defaults may use only Claxedo or organization collection plugins"), 400)
      }
      await acquirePluginArtifact({
        tree: candidate.tree,
        store: input.artifacts,
        commit: async (artifact) => {
          revision = await input.activations.mutateOrganizationDefault(auth, { ...body, artifact: pin(candidate, artifact.digest) })
        },
      })
    } else {
      revision = await input.activations.mutateOrganizationDefault(auth, body)
    }
    const reconciliation = await apply(revision!)
    return c.json({ revision, reconciliation }, reconciliation.state === "failed" ? 202 : 200)
  })

  app.post("/update", async (c) => {
    const authResult = await authenticate(c.req.raw)
    if ("error" in authResult || !authResult.auth) return c.json("error" in authResult ? authResult.error : error("missing_bearer_token", "Signed auth is required"), "status" in authResult ? authResult.status : 401)
    const auth = authResult.auth
    const body = updateMutation(await c.req.json().catch(() => undefined))
    if (!body) return c.json(error("agent_plugins_invalid_body", "Invalid Agent Plugins update request"), 400)
    const known = (await input.activations.listKnown(auth)).find((item) => item.pluginInstanceId === body.pluginInstanceId)
    const ownedPin = body.authority === "user" ? known?.pins.user : known?.pins.organization
    if (!ownedPin) return c.json(error("agent_plugins_pin_not_owned", `No retained ${body.authority} artifact exists for this plugin`), 409)
    const candidate = await currentCandidate(input.sources, auth, body.pluginInstanceId)
    if (!candidate) return c.json(error("agent_plugins_candidate_unavailable", "Plugin is not available in the current catalog"), 409)
    if (body.authority === "organization" && candidate.sourceKind === "personal") {
      return c.json(error("agent_plugins_organization_source_required", "Organization artifacts may use only Claxedo or organization collection plugins"), 400)
    }
    let revision: number | undefined
    await acquirePluginArtifact({
      tree: candidate.tree,
      store: input.artifacts,
      commit: async (artifact) => {
        const mutation = {
          pluginInstanceId: body.pluginInstanceId,
          expectedRevision: body.expectedRevision,
          artifact: pin(candidate, artifact.digest),
        }
        revision = body.authority === "user"
          ? await input.activations.updateUserArtifact(auth, mutation)
          : await input.activations.updateOrganizationArtifact(auth, mutation)
      },
    })
    const reconciliation = await apply(revision!)
    return c.json({ revision, reconciliation }, reconciliation.state === "failed" ? 202 : 200)
  })

  return app
}
