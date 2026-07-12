import { isFilesystemDirectory, isLocalSessionDirectory } from "./legacy-resolver"

export type SessionHost = "central" | "workspace"

// Canonical harness-id list — the SINGLE source of truth for the set of harness
// kinds across the app. `HarnessId` here, `HarnessKind` in
// `../harnesses/profile.ts`, and `HARNESS_IDS` in
// `session/harness/profile.ts` all derive from this one array so the
// three definitions can never drift apart again (they had drifted: profile.ts's
// list was missing `cursor-sdk` and `pi`, silently mis-classifying persisted
// profiles of those kinds — see `durability/projections.ts`).
export const HARNESS_IDS = [
  "claude-acp",
  "codex-acp",
  "cursor-acp",
  "claude-sdk",
  "codex-app-server",
  "cursor-sdk",
  "opencode",
  "pi",
] as const
export type HarnessId = (typeof HARNESS_IDS)[number]

// Validating parse for arbitrary stored strings (persisted projections, wire
// payloads). Prefer this over an unchecked `as HarnessId`/`as HarnessKind` cast.
export function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === "string" && (HARNESS_IDS as readonly string[]).includes(value)
}

export type HarnessRef = { readonly id: HarnessId; readonly binary?: string }

export type SandboxRef =
  | { readonly kind: "virtual" }
  | { readonly kind: "workspace"; readonly workspaceId: string; readonly hosting: "cloud" | "user-hosted"; readonly hostId?: string }
  | { readonly kind: "local"; readonly cwd: string }

export type SessionRef = {
  readonly sessionId: string
  readonly host: SessionHost
  readonly workspaceId?: string
  readonly toolSandbox?: SandboxRef
  readonly cwd?: string
  readonly harness?: HarnessRef
}

export type WorkspaceSessionBacking = {
  readonly workspaceId: string
  readonly kind: Extract<SandboxRef, { kind: "workspace" }>["hosting"]
  readonly hostId?: string
}

export function sessionKey(ref: SessionRef) {
  return ref.sessionId
}

export function workspaceKey(ref: SessionRef) {
  return ref.toolSandbox?.kind === "workspace" ? ref.toolSandbox.workspaceId : ref.workspaceId
}

export function hasBacking(ref: SessionRef) {
  return ref.toolSandbox?.kind === "workspace" || ref.toolSandbox?.kind === "local"
}

export function sessionHarness(ref: SessionRef): HarnessRef {
  return ref.harness ?? { id: "opencode" }
}

export function centralSessionRef(input: {
  sessionId?: string
  workspaceId?: string
  harness?: HarnessRef
}): SessionRef | undefined {
  const sessionId = input.sessionId?.trim()
  if (!sessionId) return undefined
  return {
    sessionId,
    host: "central",
    toolSandbox: { kind: "virtual" },
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.harness ? { harness: input.harness } : {}),
  }
}

export function workspaceBackedSessionRef(input: {
  sessionId?: string
  workspace: WorkspaceSessionBacking
  harness?: HarnessRef
}): SessionRef | undefined {
  const sessionId = input.sessionId?.trim()
  if (!sessionId) return undefined
  return {
    sessionId,
    host: "workspace",
    workspaceId: input.workspace.workspaceId,
    toolSandbox: {
      kind: "workspace",
      workspaceId: input.workspace.workspaceId,
      hosting: input.workspace.kind,
      ...(input.workspace.hostId ? { hostId: input.workspace.hostId } : {}),
    },
    ...(input.harness ? { harness: input.harness } : {}),
  }
}

export function localSessionRef(input: {
  sessionId?: string
  cwd?: string
  harness?: HarnessRef
}): SessionRef | undefined {
  const sessionId = input.sessionId?.trim()
  const cwd = input.cwd
  if (!sessionId || !cwd || !isFilesystemDirectory(cwd)) return undefined
  return {
    sessionId,
    host: "workspace",
    cwd,
    toolSandbox: { kind: "local", cwd },
    ...(input.harness ? { harness: input.harness } : {}),
  }
}

export function localSessionRefForDirectory(input: {
  sessionId?: string
  directory?: string
  harness?: HarnessRef
}): SessionRef | undefined {
  const sessionId = input.sessionId?.trim()
  if (!sessionId) return undefined
  return localSessionRef({ sessionId, cwd: input.directory, harness: input.harness })
}

export function sessionRefForWorkspaceSession(input: {
  sessionId?: string
  directory?: string
  workspace?: WorkspaceSessionBacking
  harness?: HarnessRef
}): SessionRef | undefined {
  if (input.workspace) {
    return workspaceBackedSessionRef({
      sessionId: input.sessionId,
      workspace: input.workspace,
      harness: input.harness,
    })
  }
  return localSessionRef({ sessionId: input.sessionId, cwd: input.directory, harness: input.harness })
}

export function retargetSessionRef(input: {
  sessionId?: string
  source?: SessionRef
}): SessionRef | undefined {
  const sessionId = input.sessionId?.trim()
  if (!sessionId) return undefined
  if (input.source?.host === "central") {
    const ref = centralSessionRef({
      sessionId,
      workspaceId: input.source.workspaceId,
    })
    if (!ref) return undefined
    return {
      ...ref,
      toolSandbox: input.source.toolSandbox ?? ref.toolSandbox,
      ...(input.source.cwd ? { cwd: input.source.cwd } : {}),
      ...(input.source.harness ? { harness: input.source.harness } : {}),
    }
  }
  if (input.source?.toolSandbox?.kind === "workspace") {
    return {
      sessionId,
      host: "workspace",
      workspaceId: input.source.toolSandbox.workspaceId,
      toolSandbox: input.source.toolSandbox,
      ...(input.source.cwd ? { cwd: input.source.cwd } : {}),
      ...(input.source.harness ? { harness: input.source.harness } : {}),
    }
  }
  if (input.source?.toolSandbox?.kind === "local") {
    const cwd = input.source.cwd ?? input.source.toolSandbox.cwd
    return localSessionRef({ sessionId, cwd, harness: input.source.harness })
  }
  return undefined
}

export { isLocalSessionDirectory }
