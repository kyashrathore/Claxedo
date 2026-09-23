/**
 * The frames the two streams deliver, and the emitter every frame enters.
 *
 * The union keeps each shape in sync with its producer across the package
 * boundary: the control-plane notices with `ControlPlaneEvent`
 * (claxedo-server-core `platform/runtime/lib/bus.ts`), the pty/process/
 * agent/session control frames with `WorkspaceRuntimeEvent`
 * (workspace-runtime `bus.ts`), and the session frames with the runtime's
 * projected presentation events (`ClientPresentationEvent`).
 * `ClaxedoEventsProvider` (./claxedo-events.tsx) reads the streams and feeds
 * the emitter; consumers subscribe by type or listen to all.
 */

import { asRecord, readString } from "@/lib/record"
import type { SessionLifecycleEvent } from "../../features/session/data/session-lifecycle"
import type { DocumentChangedEvent } from "../../features/documents/data/document-changed-event"
import type { ClaxedoEventStreamTarget, StreamFrameAddress } from "./claxedo-event-targets"
import { applyWorktreeLifecycleEvent } from "@/platform/sync/worktree"

export type PtyInfo = {
  id: string
  title: string
  command: string
  args: string[]
  cwd: string
  status: "running" | "exited"
  pid: number
}

type SessionShareChangedEvent = {
  type: "session.share.changed"
  ownerUserId: string
  sessionId: string
  workspaceId: string
  orgId?: string
  ts: number
} & (
  /** A downgrade rings `granted` at the narrower level: the share still exists. */
  | { phase: "granted"; level: "follow" | "send" }
  | { phase: "revoked" }
)

/** A workspace's inventory gained or lost a session in the control plane's projection; the reader re-reads it. */
type SessionInventoryChangedEvent = {
  type: "session.inventory.changed"
  workspaceId: string
  orgId?: string
  ts: number
}

export type ClaxedoEvent =
  | { type: "pty.created"; info: PtyInfo }
  | { type: "pty.updated"; info: PtyInfo }
  | { type: "pty.exited"; id: string; exitCode: number }
  | { type: "pty.deleted"; id: string }
  | {
      type: "pty.stream"
      id: string
      kind: "exit" | "disconnect" | "error" | "command-exit"
      exitCode?: number
      message?: string
    }
  | {
      type: "agent.lifecycle"
      tabId: string
      terminalId?: string
      workspaceId?: string
      provider?: string
      sessionId?: string
      transcriptPath?: string
      refName?: string
      prompt?: string
      lastAssistantMessage?: string
      eventType: "Busy" | "Idle" | "UserActionRequired" | "Error"
      outcome?: "done" | "error" | "cancelled"
    }
  | { type: "process.started"; directory?: string; configId: string; ptyId: string }
  /**
   * `exitCode` is absent when the owner stopped the process without reading one
   * — a retirement it could not verify reports no code rather than inventing 0.
   */
  | { type: "process.stopped"; directory?: string; configId: string; exitCode?: number }
  | { type: "process.crashed"; directory?: string; configId: string; exitCode: number; restartCount: number; commandExit?: boolean; ptyId?: string }
  | { type: "process.status"; directory?: string; configId: string; status: string }
  | { type: "process.config.changed"; directory?: string; configs: unknown[] }
  | { type: "worktree.ready"; directory: string; name: string; branch: string }
  | { type: "worktree.failed"; directory: string; message: string }
  | SessionLifecycleEvent
  | DocumentChangedEvent
  | SessionShareChangedEvent
  | SessionInventoryChangedEvent
  /** Figures for the Usage-limits view landed from one of their sources; the view re-reads. */
  | { type: "usage.quota.changed"; ts: number }
  | ClaxedoDirectoryEvent
  | {
      type: "provision"
      workspaceId: string
      step: "acquiring_sandbox" | "cloning" | "starting_runtime" | "waiting_health" | "ready" | "error"
      message?: string
      totalMs?: number
      ts: number
    }
  /**
   * A stream's own notice that frames between the reader's cursor and the
   * live position are gone. Raised for a rolled replay ring and for frames
   * shed under a slow consumer alike. A `wr` gap names the workspace whose
   * sessions have to be re-read, or no workspace when the hole is the host
   * aggregate's and every runtime the daemon embeds is behind it; a `cp` gap means
   * every notice the control plane could have sent — a worktree landing, a
   * share, a document save — has to be re-read from its source.
   */
  | { type: "stream.replay-gap"; stream: "cp"; transport: "server" | "account" }
  | { type: "stream.replay-gap"; stream: "wr"; workspaceId?: string; directory?: string }
  | { type: "subagent.updated"; directory?: string; workspaceId?: string; properties: unknown }
  | { type: "goal.updated"; directory?: string; workspaceId?: string; properties: unknown }
  | { type: "goal.cleared"; directory?: string; workspaceId?: string; properties: unknown }

type ClaxedoDirectoryEventType =
    | "message.updated"
    | "message.part.updated"
    | "message.part.delta"
    | "message.completed"
    | "session.idle"
    | "session.error"
    | "session.status"
    | "session.updated"
    | "session.deleted"
    | "session.agent"
    | "session.commands"
    | "todo.updated"
    | "permission.asked"
    | "permission.replied"
    | "question.asked"
    | "question.replied"
    | "question.rejected"
    | "session.diff"
    | "session.compacted"

export type ClaxedoDirectoryEvent = { [Type in ClaxedoDirectoryEventType]: {
  type: Type
  directory?: string
  /**
   * The workspace the frame was published for: what the frame itself names,
   * else the workspace whose stream delivered it (`stampWorkspace`). The
   * session-title projection keys entries by it as well as by `directory`;
   * a `session.updated` retitle that carries no workspace is written under
   * the directory key only, which the workspace-attributed rail rows never
   * read.
   */
  workspaceId?: string
  properties?: unknown
} }[ClaxedoDirectoryEventType]

export type ClaxedoEventType = ClaxedoEvent["type"]
type ClaxedoEventOf<T extends ClaxedoEventType> = Extract<ClaxedoEvent, { type: T }>

export type Handler<T extends ClaxedoEventType> = (event: ClaxedoEventOf<T>) => void

export function createClaxedoEventEmitter() {
  const handlers = new Map<ClaxedoEventType, Set<Handler<ClaxedoEventType>>>()
  const listeners = new Set<(event: ClaxedoEvent) => void>()

  return {
    listen: (listener: (event: ClaxedoEvent) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    on<T extends ClaxedoEventType>(type: T, handler: Handler<T>) {
      if (!handlers.has(type)) handlers.set(type, new Set())
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- as-any: handlers are stored in one map and recovered by the discriminant key.
      handlers.get(type)!.add(handler as unknown as Handler<ClaxedoEventType>)
      return () => {
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- as-any: remove uses the same discriminant-keyed handler registered above.
        handlers.get(type)?.delete(handler as unknown as Handler<ClaxedoEventType>)
      }
    },
    emit(event: ClaxedoEvent) {
      applyWorktreeLifecycleEvent(event)
      for (const listener of listeners) {
        try { listener(event) } catch {}
      }
      const set = handlers.get(event.type)
      if (!set) return
      for (const handler of set) {
        try {
          handler(event as ClaxedoEventOf<ClaxedoEventType>)
        } catch {
        }
      }
    },
  }
}

/**
 * A workspace stream's session frames belong to that workspace: the
 * session-title projection keys by it as well as by directory. A frame that
 * names its own workspace keeps it. The host aggregate names no workspace —
 * it carries every local runtime's — so its frames keep the directory they
 * arrived with as their only address.
 */
export function stampWorkspace(event: ClaxedoEvent, target: ClaxedoEventStreamTarget): ClaxedoEvent {
  if (target.kind !== "wr" || target.scope === "host") return event
  if (!("properties" in event) || !("directory" in event)) return event
  if ("workspaceId" in event && typeof event.workspaceId === "string" && event.workspaceId) return event
  return { ...event, workspaceId: target.workspaceId }
}

export function isStreamReplayGap(input: unknown) {
  return asRecord(input)?.type === "stream.replay-gap"
}

export function isClaxedoEvent(input: unknown): input is ClaxedoEvent | { type: "heartbeat" } {
  return !!input && typeof input === "object" && "type" in input && typeof input.type === "string"
}

/**
 * One stream frame, addressed the way this app addresses that workspace.
 *
 * `address` is the stream's own translation (`eventStreamFrameAddress`): a
 * producer stamps frames with the only path it knows — its own — and for a
 * relay-backed workspace that path names nothing this app can resolve, while
 * every consumer keys on the `workspace:<id>` form the pane, the rail section
 * and the session rows were registered under. It applies to the ENVELOPE's
 * directory and to a payload that carries its own, because both come from the
 * same producer.
 */
export function normalizeClaxedoStreamEvent(
  input: unknown,
  address: StreamFrameAddress = (hostDirectory) => hostDirectory,
): ClaxedoEvent | { type: "heartbeat" } | undefined {
  if (isClaxedoEvent(input)) {
    if (input.type === "heartbeat") return input
    return addressClaxedoEvent(input, address)
  }
  const envelope = asRecord(input)
  const payload = asRecord(envelope?.payload)
  if (!payload) return undefined
  if (payload.type === "heartbeat") return { type: "heartbeat" }
  // The envelope's directory addresses a payload that names none of its own.
  // Stamped on the FRAME, before it is read as a `ClaxedoEvent`: stamping it
  // after meant re-declaring the result to be one, which is false for the arms
  // whose contract has no `directory` at all (`pty.*`, `agent.lifecycle`,
  // `provision`). It also leaves `addressClaxedoEvent` as the single place the
  // address translation is applied, instead of two branches applying it apart.
  const envelopeDirectory = readString(envelope, "directory")
  const framed = readString(payload, "directory") || !envelopeDirectory
    ? payload
    : { ...payload, directory: envelopeDirectory }
  if (!isClaxedoEvent(framed) || framed.type === "heartbeat") return undefined
  return addressClaxedoEvent(framed, address)
}

function addressClaxedoEvent(event: ClaxedoEvent, address: StreamFrameAddress) {
  if (!("directory" in event) || typeof event.directory !== "string" || !event.directory) return event
  return { ...event, directory: address(event.directory) }
}
