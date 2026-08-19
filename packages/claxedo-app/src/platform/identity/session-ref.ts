import { isFilesystemDirectory, isLocalSessionDirectory } from "./legacy-resolver"

export type SessionHost = "central" | "workspace"

// Canonical BUILT-IN harness-id list — the SINGLE source of truth for the set
// of built-in harness kinds across the app. `HarnessId` here, `HarnessKind` in
// `../harnesses/profile.ts`, and `HARNESS_IDS` in
// `session/harness/profile.ts` all derive from this one array so the
// three definitions can never drift apart again (they had drifted: profile.ts's
// list was missing `cursor-sdk` and `pi`, silently mis-classifying persisted
// profiles of those kinds — see `durability/projections.ts`).
export const BUILTIN_HARNESS_IDS = [
  "claude-acp",
  "codex-acp",
  "cursor-acp",
  "claude-sdk",
  "codex-app-server",
  "cursor-sdk",
  "opencode",
  "pi",
] as const
export const HARNESS_IDS = BUILTIN_HARNESS_IDS
export type BuiltinHarnessId = (typeof BUILTIN_HARNESS_IDS)[number]

/**
 * An operator-configured ACP connection, addressed by its canonical
 * access-qualified key `acp:<slug>`. These are open by design — the server's
 * trusted config is their registry — so the app treats the key as an opaque
 * validated identity: it renders the server-provided label and never decodes
 * commands or environment from it.
 */
export type AcpConnectionHarnessId = `acp:${string}`
export type HarnessId = BuiltinHarnessId | AcpConnectionHarnessId

// Mirrors the server's ACP_CONNECTION_ID_PATTERN (agent-sdk-runtime
// harness-types.ts): stable lowercase slugs only.
const ACP_CONNECTION_KEY_PATTERN = /^acp:[a-z][a-z0-9-]{0,63}$/

export function isAcpConnectionHarnessId(value: unknown): value is AcpConnectionHarnessId {
  return typeof value === "string" && ACP_CONNECTION_KEY_PATTERN.test(value)
}

// Validating parse for arbitrary stored strings (persisted projections, wire
// payloads). Prefer this over an unchecked `as HarnessId`/`as HarnessKind` cast.
export function isHarnessId(value: unknown): value is HarnessId {
  return (typeof value === "string" && (BUILTIN_HARNESS_IDS as readonly string[]).includes(value))
    || isAcpConnectionHarnessId(value)
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

export function isDirectorylessPiSession(input: { directory?: string | null; sessionRef?: SessionRef }) {
  return !input.directory &&
    input.sessionRef?.host === "central" &&
    sessionHarness(input.sessionRef).id === "pi"
}

export function supportsSessionDirectory(input: { directory?: string | null; sessionRef?: SessionRef }) {
  return !!input.directory || input.sessionRef?.host !== "central" || isDirectorylessPiSession(input)
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
