/**
 * Convex Mirror Adapter — interface and wiring for publishing
 * workspace/session/image state to the central queryable store.
 *
 * The authority object emits AuthorityEvents. This module subscribes
 * to those events and batches/debounces writes to Convex.
 *
 * For v1, the adapter interface is defined here but the actual Convex
 * client integration lives in the hosted product layer (outside
 * claxedo-server). A no-op adapter is provided for local/dev use.
 */

import type { AuthorityEvent, WorkspaceLease, WorkspaceHold } from "./authority-types"
import type { PreparedImage, RuntimeSnapshot } from "../storage/prepared-image.sql"
import * as authority from "./authority"
import { Log } from "../log"

const log = Log.create({ service: "mirror" })

// ── Mirror adapter interface ───────────────────────────────────────────

export interface MirrorAdapter {
  /** Mirror a workspace lease state change. */
  syncLease(lease: WorkspaceLease): Promise<void>

  /** Remove a workspace from the mirror (tombstone). */
  removeLease(workspaceId: string): Promise<void>

  /** Mirror a prepared image record. */
  syncPreparedImage(image: PreparedImage): Promise<void>

  /** Mirror a runtime snapshot record. */
  syncSnapshot(snapshot: RuntimeSnapshot): Promise<void>

  /** Mirror an audit event. */
  audit(event: AuditEntry): Promise<void>
}

export type AuditEntry = {
  workspace_id: string
  event_type: string
  detail: Record<string, unknown>
  timestamp: number
}

// ── No-op adapter (local/dev) ──────────────────────────────────────────

export const noopAdapter: MirrorAdapter = {
  async syncLease() {},
  async removeLease() {},
  async syncPreparedImage() {},
  async syncSnapshot() {},
  async audit() {},
}

// ── Active adapter ─────────────────────────────────────────────────────

let adapter: MirrorAdapter = noopAdapter
let unsubscribe: (() => void) | undefined

export function setAdapter(next: MirrorAdapter) {
  adapter = next
}

export function getAdapter(): MirrorAdapter {
  return adapter
}

// ── Event handler ──────────────────────────────────────────────────────

/**
 * Debounce lease syncs — lease_updated events can fire frequently
 * (heartbeat, activity). We batch by workspace and flush periodically.
 */
const pendingLeases = new Map<string, WorkspaceLease>()
let flushTimer: ReturnType<typeof setTimeout> | undefined
const FLUSH_INTERVAL_MS = 5_000

function scheduleMirrorFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = undefined
    flushPendingLeases()
  }, FLUSH_INTERVAL_MS)
}

function flushPendingLeases() {
  const entries = [...pendingLeases.entries()]
  pendingLeases.clear()
  for (const [, lease] of entries) {
    adapter.syncLease(lease).catch((err) => {
      log.warn("Mirror syncLease failed", {
        workspaceId: lease.workspace_id,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }
}

function handleEvent(event: AuthorityEvent) {
  switch (event.type) {
    case "lease_acquired":
    case "lease_updated":
      pendingLeases.set(event.lease.workspace_id, event.lease)
      scheduleMirrorFlush()
      break

    case "lease_released":
      pendingLeases.delete(event.workspace_id)
      adapter.removeLease(event.workspace_id).catch((err) => {
        log.warn("Mirror removeLease failed", {
          workspaceId: event.workspace_id,
          error: err instanceof Error ? err.message : String(err),
        })
      })
      adapter.audit({
        workspace_id: event.workspace_id,
        event_type: "lease_released",
        detail: { reason: event.reason },
        timestamp: Date.now(),
      }).catch(() => {})
      break

    case "epoch_bumped":
      adapter.audit({
        workspace_id: event.workspace_id,
        event_type: "epoch_bumped",
        detail: { old_epoch: event.old_epoch, new_epoch: event.new_epoch },
        timestamp: Date.now(),
      }).catch(() => {})
      break

    case "heartbeat_rejected":
      adapter.audit({
        workspace_id: event.workspace_id,
        event_type: "heartbeat_rejected",
        detail: { reason: event.reason, envelope: event.envelope },
        timestamp: Date.now(),
      }).catch(() => {})
      break

    case "hold_acquired":
    case "hold_released":
      // Holds are not mirrored to Convex for v1 — they're local coordination
      break
  }
}

// ── Lifecycle ──────────────────────────────────────────────────────────

export function startMirror() {
  if (unsubscribe) return
  unsubscribe = authority.subscribe(handleEvent)
  log.info("Mirror started")
}

export function stopMirror() {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = undefined
  }
  flushPendingLeases()
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = undefined
  }
  log.info("Mirror stopped")
}
