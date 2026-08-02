import type { AttentionItem } from "@claxedo/workgraph/contracts"
import { Button } from "@opencode-ai/ui/button"
import { For, Show } from "solid-js"
import type { WorkGraphSessionOpener } from "../api"
import { ActionError, createAction } from "./dialog-action"
import type { WorkGraphWaitingSource } from "./waiting-source"
import { DialogField, DialogSection } from "./workgraph-dialog"

export function MasterEscalationContent(props: {
  item: Extract<AttentionItem, { kind: "master_escalation" }>
  source: WorkGraphWaitingSource
  onResolved: () => void
  onClose: () => void
  onOpenSession?: WorkGraphSessionOpener
  onOpenSettings?: () => void
}) {
  // The resolution affordance dispatches on the typed category — never on the
  // prose of `reason`, which either backend may reword. The prefix check is
  // only a fallback for escalation rows written before the category existed.
  const confirmation = () =>
    props.item.category === "public_pr_confirmation" ||
    (props.item.category === undefined && props.item.reason.startsWith("Confirm the first non-draft pull request"))
  const budgetExhausted = () => props.item.category === "budget_exhausted"
  const action = createAction(() => {
    props.onResolved()
    props.onClose()
  })
  const confirm = () => action.run(async () => {
    const stream = await props.source.stream(props.item.streamId)
    return props.source.confirmPublicPr(stream.id, stream.version)
  })

  return (
    <div class="workgraph-detail">
      <p class="workgraph-detail-lede text-text-strong">
        {confirmation()
          ? "The Stream master is holding an externally visible action for your confirmation."
          : budgetExhausted()
            ? "The Stream reached its compiled budget and paused new work."
          : "The Stream master stopped after repeated failure."}
      </p>
      <DialogField label="Reason">{props.item.reason}</DialogField>
      <DialogField label="Stream" mono>{props.item.streamId}</DialogField>
      <Show when={confirmation()}>
        <div class="workgraph-detail-actions">
          <Button size="small" variant="primary" disabled={action.busy()} onClick={() => void confirm()}>
            {action.busy() ? "Confirming…" : "Confirm public PR"}
          </Button>
        </div>
        <ActionError message={action.error()} />
      </Show>
      <Show when={budgetExhausted() && props.onOpenSettings}>
        <div class="workgraph-detail-actions">
          <Button
            size="small"
            variant="primary"
            onClick={() => {
              props.onClose()
              props.onOpenSettings?.()
            }}
          >
            Open Stream settings
          </Button>
        </div>
      </Show>
      <Show when={props.item.sessionId} keyed>
        {(sessionId) => (
          <div class="workgraph-detail-actions">
            <Button size="small" variant="primary" onClick={() => props.onOpenSession?.({ sessionId })}>
              Open in project
            </Button>
          </div>
        )}
      </Show>
      <Show when={props.item.receiptRefs.length > 0}>
        <DialogSection title="Receipts">
          <For each={props.item.receiptRefs}>{(receipt) => <code>{receipt}</code>}</For>
        </DialogSection>
      </Show>
    </div>
  )
}
