import type { PermissionOption, ToolKind } from "@agentclientprotocol/sdk"
import { asRecord } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeStoreCore } from "../shared/runtime-store"
import { selectPermissionOption, type AcpPermissionDecision } from "./permission-options"

/**
 * What an "always" answer remembers for an ACP agent: the protocol
 * classification and the agent's own title for the call. ACP carries no
 * command or pattern field of its own, so the title (the command line, for an
 * `execute` call) is the only stable identity a later request can be matched on.
 */
export type AcpPermissionGrant = { kind: ToolKind | "other"; tool: string }

const GRANTS_KEY = "acpGrants"

const KINDS: readonly AcpPermissionGrant["kind"][] = [
  "read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other",
]

function grantKind(value: unknown) {
  return KINDS.find((kind) => kind === value)
}

/** Undefined for an untitled request: with no title there is nothing to match a later request on. */
export function acpPermissionGrant(input: { kind?: ToolKind; tool?: string }): AcpPermissionGrant | undefined {
  return input.tool ? { kind: input.kind ?? "other", tool: input.tool } : undefined
}

export function readAcpGrants(state: Record<string, unknown> | null | undefined): AcpPermissionGrant[] {
  const raw = state?.[GRANTS_KEY]
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    const row = asRecord(item)
    const kind = grantKind(row?.kind)
    return kind && typeof row?.tool === "string" ? [{ kind, tool: row.tool }] : []
  })
}

export function hasAcpGrant(state: Record<string, unknown> | null | undefined, grant: AcpPermissionGrant) {
  return readAcpGrants(state).some((saved) => saved.kind === grant.kind && saved.tool === grant.tool)
}

/**
 * The agent option that answers a decision, with an "always" remembered on
 * the session whenever the agent can be answered at all. It is remembered even
 * when the agent only offers `allow_once`: that is the case in which only this
 * side can honour what the user asked for.
 */
export function answerAcpPermission(
  store: Pick<AgentRuntimeStoreCore, "getSessionConfig" | "updateSessionConfig">,
  sessionId: string,
  decision: AcpPermissionDecision,
  pending: { kind?: ToolKind; tool?: string; options: readonly PermissionOption[] },
): PermissionOption | undefined {
  const option = selectPermissionOption(decision, pending.options)
  const grant = acpPermissionGrant(pending)
  if (option && grant && decision === "allow_always") {
    store.updateSessionConfig(sessionId, {
      permissionState: withAcpGrant(store.getSessionConfig(sessionId)?.permissionState, grant),
    })
  }
  return option
}

export function withAcpGrant(
  state: Record<string, unknown> | null | undefined,
  grant: AcpPermissionGrant,
): Record<string, unknown> {
  const current = state ?? {}
  if (hasAcpGrant(current, grant)) return current
  return { ...current, [GRANTS_KEY]: [...readAcpGrants(current), grant] }
}
