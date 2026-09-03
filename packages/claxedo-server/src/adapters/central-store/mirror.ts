/**
 * Central-Store Mirror Adapter — interface and wiring for publishing
 * workspace/session/image state to the central queryable store.
 *
 * A sandbox lease event source can be injected so this module batches
 * and debounces writes to the central store without owning lease storage.
 *
 * For v1, the adapter interface is defined here but the actual store
 * client integration lives in the product layer (outside
 * claxedo-server). A no-op adapter is provided for local/dev use.
 */

import type { SandboxRowEvent, SandboxLeaseRow } from "@claxedo/sandbox-manager/lease-types"
import type { PreparedImage, RuntimeSnapshot } from "../../workspace/supervisor/prepared-image.sql"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"

const log = Log.create({ service: "mirror" })

// ── Mirror adapter interface ───────────────────────────────────────────

export interface MirrorAdapter {
  /** Mirror a workspace lease state change. */
  syncLease(lease: SandboxLeaseRow): Promise<void>

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

export type MirrorController = {
  setAdapter(next: MirrorAdapter): void
  getAdapter(): MirrorAdapter
  start(): void
  stop(): void
}

const FLUSH_INTERVAL_MS = 5_000

export function createMirrorController(input: {
  adapter?: MirrorAdapter
  subscribe?: (handler: (event: SandboxRowEvent) => void) => () => void
  flushIntervalMs?: number
} = {}): MirrorController {
  let adapter = input.adapter ?? noopAdapter
  let unsubscribe: (() => void) | undefined
  const pendingLeases = new Map<string, SandboxLeaseRow>()
  let flushTimer: ReturnType<typeof setTimeout> | undefined

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

  function scheduleMirrorFlush() {
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      flushPendingLeases()
    }, input.flushIntervalMs ?? FLUSH_INTERVAL_MS)
  }

  function handleEvent(event: SandboxRowEvent) {
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
        break
    }
  }

  return {
    setAdapter(next) {
      adapter = next
    },
    getAdapter() {
      return adapter
    },
    start() {
      if (unsubscribe) return
      if (!input.subscribe) {
        log.warn("Mirror subscription missing; start skipped")
        return
      }
      unsubscribe = input.subscribe(handleEvent)
      log.info("Mirror started")
    },
    stop() {
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
    },
  }
}
