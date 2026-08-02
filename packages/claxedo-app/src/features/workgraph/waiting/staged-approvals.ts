import type { AttentionItem, CommandResult } from "@claxedo/workgraph/contracts"
import { createSignal } from "solid-js"
import { parseApproveWorkItemsResult, WorkGraphApiError, type WorkGraphClient } from "../api"
import { normalizeError } from "../content-chrome"

/**
 * Owner-only staged-task approval, factored out of `WorkGraphContent`. Approve
 * and reject touch BOTH the canonical snapshot (the task leaves
 * `pending_approval`) and the Attention projection (the staged item drops out of
 * Needs-you), so every command reloads the canonical surface. Bulk approve sends
 * the EXACT versions the rows rendered, so a task edited since the owner looked
 * comes back `version_conflict`, stays Staged, and is flagged — never silently
 * ratified.
 */
export function createStagedApprovals(deps: {
  client: WorkGraphClient
  submitting: () => boolean
  setSubmitting: (value: boolean) => void
  setMutationError: (error: WorkGraphApiError | undefined) => void
  reloadCanonical: () => Promise<void>
}) {
  const [bulkResult, setBulkResult] = createSignal<{ streamId: string; approved: number; conflicted: number }>()
  const [conflictedStagedIds, setConflictedStagedIds] = createSignal<ReadonlySet<string>>(new Set())

  const runAttentionCommand = async (action: () => Promise<CommandResult>) => {
    if (deps.submitting()) return
    deps.setSubmitting(true)
    deps.setMutationError(undefined)
    try {
      const result = await action()
      if (!result.ok) {
        const kind = result.error.code === "version_conflict" ? "conflict" : "request_failed"
        throw new WorkGraphApiError(kind, result.error.message)
      }
      await deps.reloadCanonical()
    } catch (error) {
      deps.setMutationError(normalizeError(error))
    } finally {
      deps.setSubmitting(false)
    }
  }

  const approveStaged = (item: AttentionItem) => {
    if (item.kind !== "work_item") return
    setBulkResult()
    void runAttentionCommand(() => deps.client.approveWorkItem(item.record.id, item.record.version))
  }
  const rejectStaged = (item: AttentionItem, reason: string) => {
    if (item.kind !== "work_item" || !reason.trim()) return
    setBulkResult()
    void runAttentionCommand(() => deps.client.rejectWorkItem(item.record.id, item.record.version, reason.trim()))
  }
  const approveAllStaged = async (streamId: string, items: AttentionItem[]) => {
    const approvals = items.flatMap((item) =>
      item.kind === "work_item" ? [{ workItemId: item.record.id, expectedVersion: item.record.version }] : [],
    )
    if (!approvals.length || deps.submitting()) return
    deps.setSubmitting(true)
    deps.setMutationError(undefined)
    setBulkResult()
    try {
      const result = await deps.client.approveWorkItems(approvals)
      if (!result.ok) throw new WorkGraphApiError("request_failed", result.error.message)
      const parsed = parseApproveWorkItemsResult(result)
      const conflicted = parsed?.results.filter((entry) => entry.outcome !== "approved") ?? []
      const approved = (parsed?.results.length ?? approvals.length) - conflicted.length
      setConflictedStagedIds(new Set(conflicted.map((entry) => entry.workItemId)))
      setBulkResult(conflicted.length ? { streamId, approved, conflicted: conflicted.length } : undefined)
      await deps.reloadCanonical()
    } catch (error) {
      deps.setMutationError(normalizeError(error))
    } finally {
      deps.setSubmitting(false)
    }
  }

  return { approveStaged, rejectStaged, approveAllStaged, bulkResult, conflictedStagedIds }
}
