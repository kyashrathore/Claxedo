import z from "zod/v3"
import type { IPty } from "@lydell/node-pty"
import type { CreationIdentity, DescendantSweep, LaunchOwnershipStore, RetirementResult } from "@claxedo/process-ownership/launch"
import type { RuntimeBus, SessionAccessActor, SessionWorkspaceAuthority } from "@claxedo/session-core"
import type { QueuedOperation } from "./write-queue"
import type { ModeTracker } from "./mode-tracker"
import type { createDiskHistory } from "./history-disk"
import type { WebSocketBackpressureSocket } from "./websocket-backpressure"

export type AgentHookAccessBinding = {
  token: string
  context: {
    actor: SessionAccessActor
    authority: SessionWorkspaceAuthority
  }
  sessionId: string
  authorityLease: string
  authorityExpiresAt: number
}
export const Info = z.object({
  id: z.string(),
  sessionId: z.string().optional(),
  createRequestId: z.string().min(1).max(128).optional(),
  title: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  status: z.enum(["running", "exited"]),
  pid: z.number(),
})

export type Info = z.infer<typeof Info>

export const CreateInput = z.object({
  sessionId: z.string().optional(),
  createRequestId: z.string().min(1).max(128).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  title: z.string().optional(),
  initialCommand: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  previousPtyId: z.string().optional(),
})

export type CreateInput = z.infer<typeof CreateInput>

export const UpdateInput = z.object({
  title: z.string().optional(),
  size: z
    .object({
      rows: z.number(),
      cols: z.number(),
    })
    .optional(),
})

export type UpdateInput = z.infer<typeof UpdateInput>

export const Event = {
  Created: { type: "pty.created" as const },
  Updated: { type: "pty.updated" as const },
  Exited: { type: "pty.exited" as const },
  Deleted: { type: "pty.deleted" as const },
  Stream: { type: "pty.stream" as const },
}

export interface ActiveSession {
  /** The bus of the session core that created this terminal; every frame it publishes goes there. */
  bus: RuntimeBus
  info: Info
  process: IPty
  buffer: string
  bufferCursor: number
  cursor: number
  /**
   * Headless emulator mirroring this PTY's output, so a reattaching renderer
   * can be resynced to the modes the RUNNING program actually has set rather
   * than to a snapshot the renderer guessed earlier. See mode-tracker.ts.
   */
  modeTracker: ModeTracker
  onResize(): void
  history: Awaited<ReturnType<typeof createDiskHistory>>
  osc7: string
  subscribers: Set<WebSocketBackpressureSocket>
  exited: boolean
  removed: boolean
  ready: boolean
  writeQueue: QueuedOperation[]
  queuedBytes: number
  highWatermark: number
  lowWatermark: number
  createdAt: number
  firstByteAt: number | undefined
  directory: string
  /**
   * Public PTY creation is a two-phase ownership transfer. `create()` owns a
   * provisional process until the HTTP route has produced a successful
   * response; `commit()` transfers that process to the user. A committed
   * running terminal is intentionally independent of WebSocket subscribers.
   */
  committed: boolean
  orphanTimer: ReturnType<typeof setTimeout> | undefined
  cleanupOperation?: Promise<RetirementResult | undefined>
  removeOperation?: Promise<RetirementResult | undefined>
  launchId?: string
  /**
   * The store that owns this terminal's launch record. It is the one given at
   * `create`, not whatever store some other workspace installed afterwards:
   * one process serves many workspaces, and each terminal answers to its own.
   */
  store?: LaunchOwnershipStore
  identity?: CreationIdentity
  /**
   * Set when retirement did not establish that this terminal's processes are
   * gone. The entry stays addressable and keeps pinning the runtime until a
   * later `remove` settles it.
   */
  cleanup?: "unresolved"
  cleanupResult?: RetirementResult
  /**
   * Set when the spawn could not be written to the durable ownership record.
   * The process is running and nothing will ever find it again, so the entry
   * is kept and it pins the runtime exactly as unresolved cleanup does.
   */
  ownership?: "unrecorded"
  ownershipError?: string
  /**
   * Set when a settled retirement could not be recorded. The durable row
   * still claims a launch this owner has already finished, so the entry is
   * kept and the write is retried on the next `remove` or `abandon`.
   */
  persistence?: "unavailable"
  persistenceError?: string
  /**
   * What the identity-checked sweep of processes that left this terminal's
   * group found. Survivors here do not hold the entry: nothing can prove they
   * are gone, and pinning on them would never release.
   */
  escapees?: DescendantSweep
  /** Verified relay actor that created this public terminal. Never accepted
   * from request input and deliberately absent from the public PTY info. */
  accessOwnerActorId?: string
  /** One terminal-scoped callback capability derived from verified relay
   * claims at PTY creation. The child receives only the opaque token; actor,
   * tenant, workspace, and role remain runtime-owned state. */
  agentHookAccess?: AgentHookAccessBinding
}

