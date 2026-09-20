import { isFilesystemDirectory, isLocalSessionDirectory } from "./legacy-resolver"
import type { RelayHostKind } from "@/platform/runtime/placement-wire"
import {
  NATIVE_HARNESS_IDS,
  sameHarnessSelection,
  type HarnessSelection,
  type NativeHarnessId,
} from "./harness-selection"

export type { HarnessSelection, NativeHarnessId } from "./harness-selection"
export const HARNESS_IDS = NATIVE_HARNESS_IDS
export type HarnessId = string
export type BuiltinHarnessId = NativeHarnessId

export type SessionHost = "workspace"

export type HarnessRef = HarnessSelection & { readonly binary?: string }

export type SandboxRef =
  | { readonly kind: "workspace"; readonly workspaceId: string; readonly hosting: RelayHostKind; readonly hostId?: string }
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

export function sameSessionRef(a: SessionRef | undefined, b: SessionRef | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (
    a.sessionId !== b.sessionId ||
    a.host !== b.host ||
    a.workspaceId !== b.workspaceId ||
    a.cwd !== b.cwd ||
    a.toolSandbox?.kind !== b.toolSandbox?.kind ||
    !sameHarnessSelection(a.harness, b.harness) ||
    a.harness?.binary !== b.harness?.binary
  ) return false
  if (a.toolSandbox?.kind === "workspace" && b.toolSandbox?.kind === "workspace") {
    return (
      a.toolSandbox.workspaceId === b.toolSandbox.workspaceId &&
      a.toolSandbox.hosting === b.toolSandbox.hosting &&
      a.toolSandbox.hostId === b.toolSandbox.hostId
    )
  }
  if (a.toolSandbox?.kind === "local" && b.toolSandbox?.kind === "local") {
    return a.toolSandbox.cwd === b.toolSandbox.cwd
  }
  return true
}

export function hasBacking(ref: SessionRef) {
  return ref.toolSandbox?.kind === "workspace" || ref.toolSandbox?.kind === "local"
}

export function sessionHarness(ref: SessionRef): HarnessRef | undefined {
  return ref.harness
}

export function supportsSessionDirectory(input: { directory?: string | null; sessionRef?: SessionRef }) {
  return !!input.directory
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
