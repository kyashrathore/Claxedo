import { anyApi } from "convex/server"
import {
  AgentPluginActivationStoreError,
  type MutateSignedOrganizationDefault,
  type MutateSignedUserActivation,
  type AgentPluginArtifactPin,
  type SignedActivationSnapshot,
  type SignedAgentPluginActivationStore,
  type SignedKnownPlugin,
  type UpdateSignedArtifactPin,
} from "@claxedo/server-core/agent-plugins/activation/store"
import type { ArtifactDigest } from "@claxedo/server-core/agent-plugins/activation/types"
import type { AgentPluginHarnessId } from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import {
  ControlPlaneAuthError,
  serviceAuthorityUser,
  type SignedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"
import {
  requireExecutor,
  requireServiceToken,
} from "../../authority/adapters/convex/workspace-authority/executor"
import type { ConvexExecutor } from "../../authority/adapters/convex/workspace-authority/types"

// Convex's build-selected component is intentionally absent from the default
// generated API surface. This is the single typed boundary for that optional
// component; every value returned through it is validated below.
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
const agentPluginsApi = (anyApi as unknown as {
  agentPlugins: Record<string, unknown>
}).agentPlugins

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isArtifactDigest(value: unknown): value is ArtifactDigest {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value)
}

type Input = {
  url?: string
  executor?: ConvexExecutor
  serviceToken?: string
}

function authArgs(auth: SignedControlPlaneAuth) {
  return {
    user: serviceAuthorityUser(auth),
    ...(auth.user.orgId ? { clerk_org_id: auth.user.orgId } : {}),
  }
}

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

function translate(cause: unknown): never {
  const detail = message(cause)
  const conflict = detail.match(/revision-conflict:(\d+):(\d+)/)
  if (conflict) {
    throw new AgentPluginActivationStoreError(
      "revision-conflict",
      `Agent plugin activation revision changed from ${conflict[1]} to ${conflict[2]}`,
    )
  }
  if (detail.includes("artifact-unavailable")) {
    throw new AgentPluginActivationStoreError("artifact-unavailable", "The selected authority has no retained plugin artifact")
  }
  if (detail.includes("access denied")
    || detail.includes("admin access required")
    || detail.includes("membership is required")
    || detail.includes("user not found")
    || detail.includes("organization not found")) {
    throw new ControlPlaneAuthError(403, "workspace_authorization_denied", detail)
  }
  throw cause
}

function number(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Convex returned an invalid Agent Plugins revision")
  }
  return value
}

async function operationId(name: string, args: Record<string, unknown>) {
  const bytes = new TextEncoder().encode(JSON.stringify([name, args]))
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  return `agent-plugins-${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

function pin(value: unknown): AgentPluginArtifactPin | undefined {
  if (!record(value)) return undefined
  if (!isArtifactDigest(value.digest)
    || typeof value.sourceId !== "string"
    || typeof value.relativePath !== "string"
    || typeof value.sourceRevision !== "string") return undefined
  return {
    digest: value.digest,
    sourceId: value.sourceId,
    relativePath: value.relativePath,
    sourceRevision: value.sourceRevision,
  }
}

function signedSnapshot(
  result: unknown,
  input: { pluginInstanceId: string; harnessId: AgentPluginHarnessId; projectId?: string },
): SignedActivationSnapshot {
  if (!record(result)) {
    throw new Error("Convex returned an invalid Agent Plugins activation snapshot")
  }
  const pins = record(result.pins) ? result.pins : {}
  return {
    revision: number(result.revision),
    pluginInstanceId: input.pluginInstanceId,
    harnessId: input.harnessId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(typeof result.projectOverride === "boolean" ? { projectOverride: result.projectOverride } : {}),
    ...(typeof result.userDefault === "boolean" ? { userDefault: result.userDefault } : {}),
    ...(result.organizationDefault === true ? { organizationDefault: true as const } : {}),
    ...(result.claxedoDefault === true ? { claxedoDefault: true as const } : {}),
    pins: {
      ...(isArtifactDigest(pins.user) ? { user: pins.user } : {}),
      ...(isArtifactDigest(pins.organization) ? { organization: pins.organization } : {}),
      ...(isArtifactDigest(pins.claxedo) ? { claxedo: pins.claxedo } : {}),
    },
  }
}

/** Durable signed Agent Plugins metadata adapter over the build-selected Convex facade. */
export class ConvexSignedAgentPluginActivationStore implements SignedAgentPluginActivationStore {
  private readonly executor: ConvexExecutor
  private readonly serviceToken: string

  constructor(input: Input = {}) {
    this.executor = requireExecutor(input, undefined, { allowUnsigned: true })
    this.serviceToken = requireServiceToken(input)
  }

  private args(auth: SignedControlPlaneAuth) {
    return { service_token: this.serviceToken, ...authArgs(auth) }
  }

  private async query(auth: SignedControlPlaneAuth, name: string, args: Record<string, unknown> = {}) {
    try {
      return await this.executor.query(agentPluginsApi[name], { ...this.args(auth), ...args })
    } catch (cause) {
      return translate(cause)
    }
  }

  private async mutation(auth: SignedControlPlaneAuth, name: string, args: Record<string, unknown>) {
    try {
      return await this.executor.mutation(agentPluginsApi[name], {
        ...this.args(auth),
        ...args,
        operation_id: await operationId(name, args),
      })
    } catch (cause) {
      return translate(cause)
    }
  }

  async authorizeProject(auth: SignedControlPlaneAuth, projectId: string) {
    const result = await this.query(auth, "authorizeProject", { project_id: projectId })
    if (!record(result) || result.allowed !== true) {
      throw new ControlPlaneAuthError(403, "workspace_authorization_denied", "Agent Plugins project access denied")
    }
  }

  async revision(auth: SignedControlPlaneAuth) {
    return number(await this.query(auth, "revision"))
  }

  async listKnown(auth: SignedControlPlaneAuth): Promise<SignedKnownPlugin[]> {
    const result = await this.query(auth, "listKnown")
    if (!Array.isArray(result)) throw new Error("Convex returned an invalid Agent Plugins retained set")
    return result.map((value) => {
      if (!record(value)) {
        throw new Error("Convex returned an invalid Agent Plugins retained entry")
      }
      if (typeof value.pluginInstanceId !== "string") {
        throw new Error("Convex returned an invalid Agent Plugins instance ID")
      }
      const pins = record(value.pins) ? value.pins : {}
      const user = pin(pins.user)
      const organization = pin(pins.organization)
      const claxedo = pin(pins.claxedo)
      return {
        pluginInstanceId: value.pluginInstanceId,
        pins: {
          ...(user ? { user } : {}),
          ...(organization ? { organization } : {}),
          ...(claxedo ? { claxedo } : {}),
        },
      }
    })
  }

  async read(
    auth: SignedControlPlaneAuth,
    input: { pluginInstanceId: string; harnessId: AgentPluginHarnessId; projectId?: string },
  ): Promise<SignedActivationSnapshot> {
    const result = await this.query(auth, "read", {
      plugin_instance_id: input.pluginInstanceId,
      harness_id: input.harnessId,
      ...(input.projectId ? { project_id: input.projectId } : {}),
    })
    return signedSnapshot(result, input)
  }

  async mutateUser(auth: SignedControlPlaneAuth, input: MutateSignedUserActivation) {
    return number(await this.mutation(auth, "mutateUser", {
      plugin_instance_id: input.pluginInstanceId,
      harness_ids: input.harnessIds,
      choice: input.choice,
      target: input.target.scope === "all-projects"
        ? { scope: "all-projects" }
        : { scope: "projects", project_ids: input.target.projectIds },
      artifact: input.artifact,
      expected_revision: input.expectedRevision,
    }))
  }

  async mutateOrganizationDefault(auth: SignedControlPlaneAuth, input: MutateSignedOrganizationDefault) {
    return number(await this.mutation(auth, "mutateOrganizationDefault", {
      plugin_instance_id: input.pluginInstanceId,
      harness_ids: input.harnessIds,
      choice: input.choice,
      artifact: input.artifact,
      expected_revision: input.expectedRevision,
    }))
  }

  private async update(auth: SignedControlPlaneAuth, authority: "user" | "organization", input: UpdateSignedArtifactPin) {
    return number(await this.mutation(auth, "updatePin", {
      authority,
      plugin_instance_id: input.pluginInstanceId,
      artifact: input.artifact,
      expected_revision: input.expectedRevision,
    }))
  }

  updateUserArtifact(auth: SignedControlPlaneAuth, input: UpdateSignedArtifactPin) {
    return this.update(auth, "user", input)
  }

  updateOrganizationArtifact(auth: SignedControlPlaneAuth, input: UpdateSignedArtifactPin) {
    return this.update(auth, "organization", input)
  }

  async readRuntime(input: {
    ownerUserId: string
    organizationId: string
    projectId: string
    workspaceId: string
    pluginInstanceId: string
    harnessId: AgentPluginHarnessId
  }): Promise<SignedActivationSnapshot> {
    let result: unknown
    try {
      result = await this.executor.query(agentPluginsApi.runtimeRead, {
        service_token: this.serviceToken,
        owner_user_id: input.ownerUserId,
        organization_id: input.organizationId,
        project_id: input.projectId,
        workspace_id: input.workspaceId,
        plugin_instance_id: input.pluginInstanceId,
        harness_id: input.harnessId,
      })
    } catch (cause) {
      return translate(cause)
    }
    return signedSnapshot(result, input)
  }

  async runtimeSnapshot(workspaceId: string): Promise<{
    revision: number
    identity: { userId: string; organizationId: string; projectId: string; workspaceId: string }
    plugins: Array<{
      pluginInstanceId: string
      pins: SignedKnownPlugin["pins"]
      harnesses: Record<AgentPluginHarnessId, SignedActivationSnapshot>
    }>
  }> {
    let result: unknown
    try {
      result = await this.executor.query(agentPluginsApi.runtimeSnapshot, {
        service_token: this.serviceToken,
        workspace_id: workspaceId,
      })
    } catch (cause) {
      return translate(cause)
    }
    if (!record(result)) {
      throw new Error("Convex returned an invalid Agent Plugins runtime snapshot")
    }
    const identity = record(result.identity) ? result.identity : undefined
    if (!identity
      || typeof identity.userId !== "string"
      || typeof identity.organizationId !== "string"
      || typeof identity.projectId !== "string"
      || identity.workspaceId !== workspaceId
      || !Array.isArray(result.plugins)) {
      throw new Error("Convex returned an invalid Agent Plugins runtime identity")
    }
    const projectId = identity.projectId
    return {
      revision: number(result.revision),
      identity: {
        userId: identity.userId,
        organizationId: identity.organizationId,
        projectId: identity.projectId,
        workspaceId,
      },
      plugins: result.plugins.map((value) => {
        if (!record(value)) {
          throw new Error("Convex returned an invalid Agent Plugins runtime entry")
        }
        if (typeof value.pluginInstanceId !== "string"
          || !record(value.pins)
          || !record(value.harnesses)) {
          throw new Error("Convex returned an invalid Agent Plugins runtime entry")
        }
        const pins = value.pins
        const pluginInstanceId = value.pluginInstanceId
        const user = pin(pins.user)
        const organization = pin(pins.organization)
        const claxedo = pin(pins.claxedo)
        const harnesses = value.harnesses
        const snapshot = (harnessId: AgentPluginHarnessId) => signedSnapshot(harnesses[harnessId], {
          pluginInstanceId,
          harnessId,
          projectId,
        })
        return {
          pluginInstanceId,
          pins: {
            ...(user ? { user } : {}),
            ...(organization ? { organization } : {}),
            ...(claxedo ? { claxedo } : {}),
          },
          harnesses: {
            opencode: snapshot("opencode"),
            claude: snapshot("claude"),
            codex: snapshot("codex"),
            cursor: snapshot("cursor"),
          },
        }
      }),
    }
  }
}
