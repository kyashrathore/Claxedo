import type { D1Database } from "@cloudflare/workers-types"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import {
  PRIVATE_SESSION_AUTHORITY_METHODS,
  type PrivateSessionAuthority,
} from "@claxedo/server-core/platform/auth/private-session-authority"
import type { SessionTurnAuthority } from "@claxedo/server-core/platform/auth/session-turn-authority"
import {
  D1WorkspaceAuthority,
  D1_WORKSPACE_AUTHORITY_METHODS,
  type D1AuthorityProductPolicy,
  type D1WorkspaceAuthorityCore,
} from "./workspace-authority"
import {
  D1SessionAuthority,
  D1_SESSION_AUTHORITY_METHODS,
  D1_SESSION_TURN_AUTHORITY_METHODS,
  type D1SessionAuthorityPort,
} from "./session-authority"
import {
  D1HostAccessAuthority,
  D1_HOST_ACCESS_AUTHORITY_METHODS,
  type D1HostAccessAuthorityPort,
} from "./host-access-authority"
import {
  D1AgentExtensionAuthority,
  D1_AGENT_EXTENSION_AUTHORITY_METHODS,
  type D1AgentExtensionAuthorityPort,
} from "./agent-extension-authority"
import { D1AuditAuthority, D1_AUDIT_AUTHORITY_METHODS, type D1AuditAuthorityPort } from "./audit-authority"
import {
  D1ChannelRuntimeAuthority,
  D1_CHANNEL_RUNTIME_AUTHORITY_METHODS,
  type D1ChannelRuntimeAuthorityPort,
} from "./channel-runtime-authority"

/** The shared authority surface already backed by D1. */
export type D1CoreAuthorityPort = D1WorkspaceAuthorityCore &
  D1SessionAuthorityPort &
  D1HostAccessAuthorityPort &
  D1AgentExtensionAuthorityPort &
  D1AuditAuthorityPort &
  D1ChannelRuntimeAuthorityPort

const WORKSPACE_LIFECYCLE_METHODS = [
  "ensureApplicationIdentity",
  "linkApplicationIdentity",
  "admitUserDeployedIdentity",
  "createHostedOrganization",
  "addOrganizationMember",
  "createWorkspace",
  "claimUserDeployedOwner",
] as const satisfies readonly (keyof D1WorkspaceAuthority)[]

const HOST_LIFECYCLE_METHODS = [
  "revokeLocalHostLink",
  "revokeHostEnrollment",
] as const satisfies readonly (keyof D1HostAccessAuthority)[]

export type D1CoreAuthorityBoundary = WorkspaceAuthority &
  Pick<D1WorkspaceAuthority, (typeof WORKSPACE_LIFECYCLE_METHODS)[number]> &
  PrivateSessionAuthority &
  SessionTurnAuthority &
  Pick<D1HostAccessAuthority, (typeof HOST_LIFECYCLE_METHODS)[number]>

export type D1AuthorityMissingCapability = Exclude<keyof WorkspaceAuthority, keyof D1CoreAuthorityPort>

/**
 * Deliberately compile-time checked. The empty inventory is the proof that
 * the composed D1 authority implements every shared authority method; adding
 * a method to the port cannot silently turn this boundary partial again.
 */
export const D1_AUTHORITY_MISSING_CAPABILITIES = [] as const satisfies readonly D1AuthorityMissingCapability[]

type UnlistedD1Capability = Exclude<D1AuthorityMissingCapability, (typeof D1_AUTHORITY_MISSING_CAPABILITIES)[number]>
type IncorrectlyListedD1Capability = Exclude<
  (typeof D1_AUTHORITY_MISSING_CAPABILITIES)[number],
  D1AuthorityMissingCapability
>
const D1_CAPABILITY_INVENTORY_IS_EXACT: [UnlistedD1Capability, IncorrectlyListedD1Capability] extends [never, never]
  ? true
  : never = true
void D1_CAPABILITY_INVENTORY_IS_EXACT

export type D1CoreAuthorityOptions = {
  deploymentId: string
  product: D1AuthorityProductPolicy
  now?: () => number
}

/**
 * One Worker-safe authority object over one D1 binding and one deployment
 * scope. Module instances are private so callers cannot accidentally compose
 * workspace identity from one database with sessions or host state from
 * another.
 */
export function createD1CoreAuthority(database: D1Database, options: D1CoreAuthorityOptions): D1CoreAuthorityBoundary {
  const shared = { deploymentId: options.deploymentId, ...(options.now ? { now: options.now } : {}) }
  const workspace = new D1WorkspaceAuthority(database, { ...shared, product: options.product })
  const sessions = new D1SessionAuthority(database, shared)
  const hosts = new D1HostAccessAuthority(database, shared)
  const extensions = new D1AgentExtensionAuthority(database, shared)
  const audit = new D1AuditAuthority(database, shared)
  const channelsAndRuntime = new D1ChannelRuntimeAuthority(database, shared)

  return {
    ...bindMethods(workspace, D1_WORKSPACE_AUTHORITY_METHODS),
    ...bindMethods(sessions, D1_SESSION_AUTHORITY_METHODS),
    ...bindMethods(hosts, D1_HOST_ACCESS_AUTHORITY_METHODS),
    ...bindMethods(extensions, D1_AGENT_EXTENSION_AUTHORITY_METHODS),
    ...bindMethods(audit, D1_AUDIT_AUTHORITY_METHODS),
    ...bindMethods(channelsAndRuntime, D1_CHANNEL_RUNTIME_AUTHORITY_METHODS),
    ...bindMethods(workspace, WORKSPACE_LIFECYCLE_METHODS),
    ...bindMethods(sessions, PRIVATE_SESSION_AUTHORITY_METHODS),
    ...bindMethods(sessions, D1_SESSION_TURN_AUTHORITY_METHODS),
    ...bindMethods(hosts, HOST_LIFECYCLE_METHODS),
  }
}

function bindMethods<T extends object, K extends keyof T>(source: T, names: readonly K[]): Pick<T, K> {
  return Object.fromEntries(
    names.map((name) => {
      const method = source[name]
      if (typeof method !== "function") throw new TypeError(`Authority capability ${String(name)} is not callable`)
      return [name, method.bind(source)]
    }),
  ) as Pick<T, K>
}
