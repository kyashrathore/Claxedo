import type { AttemptDetailDto, AttemptDto, ResolvedExecutionProfile, StreamMasterStatus } from "@claxedo/workgraph/contracts"
import { For, Show } from "solid-js"
import type { WorkGraphSessionOpener } from "../api"
import { MasterReceiptLink } from "../master-receipt-link"
import { DialogField, DialogSection } from "./workgraph-dialog"

/** Renders safe execution references and results without repository remotes,
 * lease/control-plane tokens, credentials, or other secret-bearing fields. */
export function AttemptDetailView(props: {
  detail: AttemptDetailDto
  masterStatus?: StreamMasterStatus
  streamAttempts?: AttemptDto[]
  onOpenSession?: WorkGraphSessionOpener
}) {
  const attempt = () => props.detail.attempt
  const exec = (): ResolvedExecutionProfile => attempt().resolvedExecution
  const references = () => props.detail.executionReferences
  const receipts = () => attempt().result?.artifactRefs ?? []
  const masterReceiptAttempt = (reference: string) => props.streamAttempts
    ?.find((candidate) => candidate.result?.artifactRefs.includes(reference))
  const masterReceiptSession = (reference: string) => masterReceiptAttempt(reference)?.executionReferences?.sessionId ?? props.masterStatus?.sessionId
  const openMasterReceipt = (reference: string) => {
    const receiptAttempt = masterReceiptAttempt(reference)
    const sessionId = receiptAttempt?.executionReferences?.sessionId ?? props.masterStatus?.sessionId
    if (!sessionId || !props.onOpenSession) return
    void props.onOpenSession({
      sessionId,
      ...(receiptAttempt?.executionReferences?.workspaceId ? { workspaceId: receiptAttempt.executionReferences.workspaceId } : {}),
      harness: receiptAttempt?.resolvedExecution.harness,
      environment: receiptAttempt?.resolvedExecution.environment,
    })
  }
  return (
    <div class="workgraph-detail-grid">
      <DialogField label="Attempt">#{attempt().attemptNumber} · {attempt().state}</DialogField>
      <Show when={attempt().attentionReason}>
        {(reason) => (
          <div class="workgraph-attempt-error" role="alert">
            <span class="text-[11px] font-semibold text-text-strong">{attempt().state === "failed" ? "Attempt failed" : "Attempt needs attention"}</span>
            <span class="text-[12px] leading-5 text-text-base">{reason()}</span>
          </div>
        )}
      </Show>
      <DialogField label="Environment">
        {exec().environment.kind.replaceAll("_", " ")}
        <Show when={exec().environment.presetId}> · {exec().environment.presetId}</Show>
      </DialogField>
      <DialogField label="Model">{exec().model.providerId}/{exec().model.modelId}</DialogField>
      <DialogField label="Effort">{exec().effort}</DialogField>
      <DialogField label="Agent">{exec().agent}</DialogField>
      <DialogField label="Harness">{exec().harness}</DialogField>
      <Show when={exec().repository?.baseRevision}>
        <DialogField label="Base revision" mono>{exec().repository!.baseRevision}</DialogField>
      </Show>
      <DialogField label="Tools">{exec().tools.length ? exec().tools.join(", ") : "none"}</DialogField>
      <DialogField label="Connections">{exec().connectionIds.length ? exec().connectionIds.join(", ") : "none"}</DialogField>
      <Show when={references()?.sessionId}>
        {(sessionId) => (
          <DialogField label="Session" mono>
            <Show when={props.onOpenSession} fallback={sessionId()}>
              {(openSession) => (
                <button
                  type="button"
                  class="workgraph-session-link"
                  aria-label={`Open session ${sessionId()}`}
                  onClick={() => void openSession()({
                    sessionId: sessionId(),
                    ...(references()?.workspaceId ? { workspaceId: references()!.workspaceId } : {}),
                    harness: exec().harness,
                    environment: exec().environment,
                  })}
                >
                  {sessionId()}
                </button>
              )}
            </Show>
          </DialogField>
        )}
      </Show>
      <Show when={references()?.workspaceId}>
        <DialogField label="Workspace" mono>{references()!.workspaceId}</DialogField>
      </Show>
      <Show when={references()?.childWorkspaceId}>
        <DialogField label="Child workspace" mono>{references()!.childWorkspaceId}</DialogField>
      </Show>
      <Show when={attempt().result}>
        {(result) => (
          <div class="workgraph-detail-result">
            <span class="workgraph-dfield-label text-text-weaker">Result</span>
            <p class="text-[12px] leading-5 text-text-base">{result().summary}</p>
          </div>
        )}
      </Show>
      <Show when={props.masterStatus?.receiptRefs.length}><DialogSection title="Master activity">
        <p class="text-[12px] leading-5 text-text-base">{props.masterStatus!.message}</p>
        <ul class="workgraph-detail-artifacts">
          <For each={props.masterStatus!.receiptRefs}>{(reference, index) => (
            <li class="flex items-center justify-between gap-3 text-[11px] text-text-weaker">
              <span>Master action {index() + 1}</span>
              <MasterReceiptLink
                reference={reference}
                label="Open receipt"
                onOpen={props.onOpenSession && masterReceiptSession(reference) ? () => openMasterReceipt(reference) : undefined}
              />
            </li>
          )}</For>
        </ul>
      </DialogSection></Show>
      <Show when={receipts().length}><DialogSection title="Receipts">
        <ul class="workgraph-detail-artifacts"><For each={receipts()}>{(ref) => <li class="font-mono text-[11px] text-text-weaker">{ref}</li>}</For></ul>
      </DialogSection></Show>
    </div>
  )
}
