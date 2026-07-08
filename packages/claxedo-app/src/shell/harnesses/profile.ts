import type { SessionHost } from "../identity/session-ref"
import type { ModelKey } from "../../session-client/composer/model-strategy"

export type HarnessKind =
  | "opencode"
  | "claude-acp"
  | "codex-acp"
  | "cursor-acp"
  | "claude-sdk"
  | "codex-app-server"

export type HarnessScope = "user" | "workspace" | "org"

export type HarnessProfile = {
  id: string
  kind: HarnessKind
  label: string
  model: ModelKey
  effort?: "low" | "medium" | "high"
  credentialRef?: string
  scope: HarnessScope
  workspaceId?: string
}

const workspaceOnlyKinds: ReadonlySet<HarnessKind> = new Set([
  "opencode",
  "claude-acp",
  "codex-acp",
  "cursor-acp",
  "codex-app-server",
])

export function compatibleHosts(profile: Pick<HarnessProfile, "kind">): readonly SessionHost[] {
  return workspaceOnlyKinds.has(profile.kind) ? ["workspace"] : ["central", "workspace"]
}

export function canSelectHarnessForHost(profile: Pick<HarnessProfile, "kind">, host: SessionHost) {
  return compatibleHosts(profile).includes(host)
}

export function requireCompatibleHarness(profile: HarnessProfile, host: SessionHost) {
  if (canSelectHarnessForHost(profile, host)) return profile
  throw new Error(`${profile.kind} harness cannot be selected for ${host} sessions`)
}

export function harnessProfileFromLegacy(input: {
  id?: string
  kind: HarnessKind
  label?: string
  model: string | ModelKey
  scope?: HarnessScope
  workspaceId?: string
  credentialRef?: string
}): HarnessProfile {
  return {
    id: input.id ?? `${input.scope ?? "user"}:${input.workspaceId ?? "global"}:${input.kind}`,
    kind: input.kind,
    label: input.label ?? input.kind,
    model: typeof input.model === "string"
      ? { providerID: input.kind, modelID: input.model }
      : input.model,
    ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}),
    scope: input.scope ?? (input.workspaceId ? "workspace" : "user"),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
  }
}
