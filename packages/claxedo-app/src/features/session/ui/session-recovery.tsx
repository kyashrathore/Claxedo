import { For, Show, createEffect, createResource, createSignal, onCleanup } from "solid-js"
import type {
  CleanupFact,
  ExecutionFact,
  PersistenceFact,
  RecoveryError,
  RecoveryFactEvidence,
  RecoveryFacts,
  RecoveryOperation,
  RecoveryAction,
  RecoveryOperationState,
  RecoveryOutcome,
  RecoveryPhase,
  RecoveryRequest,
  RecoveryTurnTarget,
} from "@claxedo/agent-runtime-contract"
import { isRecoveryOutcome } from "@claxedo/agent-runtime-contract"
import { Button } from "@opencode-ai/ui/button"
import { useLanguage } from "@/platform/i18n/provider"
import { RecoveryCommandFailure, stopRunningTurn } from "../composer/ui/submit-abort"
import {
  clearSessionRecoveryCommand,
  sessionRecoveryCommand,
  settleSessionRecoveryCommand,
  startSessionRecoveryCommand,
  subscribeSessionRecoveryCommand,
} from "../store/session-status-dispatcher"
import {
  describeRecoveryOutcome,
  describeRecoveryUnreachable,
  recoveryToastText,
  type RecoveryCopy,
} from "./recovery-outcome-copy"

type DictionaryKey = Parameters<ReturnType<typeof useLanguage>["t"]>[0]

/**
 * The inspection as this page reads it, spelled from contract types rather than
 * imported from the runtime package: the app depends on the contract alone, and
 * the owner's health is the one member the contract does not name.
 */
type SessionRecoveryInspection = {
  sessionId: string
  target?: RecoveryTurnTarget
  facts: RecoveryFacts
  health: { status: "ok" | "degraded" | "unavailable"; reason?: string; message?: string }
  failures: RecoveryError[]
  operations: RecoveryOperation[]
  queued: number
}

export type SessionRecoveryClient = {
  session: {
    recovery: {
      inspect(input: { sessionID: string; directory?: string }): Promise<{
        data: SessionRecoveryInspection | RecoveryOutcome
      }>
      submit(input: { sessionID: string; directory?: string; request: RecoveryRequest }): Promise<{ data: RecoveryOutcome }>
    }
  }
}

/**
 * Listed per value rather than built from it, so every key is a literal a
 * dictionary audit can find a reader for.
 */
const EXECUTION_KEYS: Record<ExecutionFact, DictionaryKey> = {
  running: "session.recovery.value.running",
  terminal: "session.recovery.value.terminal",
  unknown: "session.recovery.value.executionUnknown",
}

const CLEANUP_KEYS: Record<CleanupFact, DictionaryKey> = {
  owned: "session.recovery.value.owned",
  verified_clear: "session.recovery.value.verifiedClear",
  unknown: "session.recovery.value.cleanupUnknown",
}

const HEALTH_KEYS: Record<SessionRecoveryInspection["health"]["status"], DictionaryKey> = {
  ok: "session.recovery.health.ok",
  degraded: "session.recovery.health.degraded",
  unavailable: "session.recovery.health.unavailable",
}

const ACTION_KEYS: Record<RecoveryAction, DictionaryKey> = {
  inspect: "session.recovery.action.inspect",
  cancel_turn: "session.recovery.action.cancelTurn",
  reconcile_session: "session.recovery.action.reconcileSession",
  retire_harness: "session.recovery.action.retireHarness",
  drain_daemon: "session.recovery.action.drainDaemon",
  stop_daemon: "session.recovery.action.stopDaemon",
  release_drain: "session.recovery.action.releaseDrain",
}

const STATE_KEYS: Record<RecoveryOperationState, DictionaryKey> = {
  accepted: "session.recovery.state.accepted",
  running: "session.recovery.state.running",
  succeeded: "session.recovery.state.succeeded",
  failed: "session.recovery.state.failed",
  needs_action: "session.recovery.state.needsAction",
}

const PHASE_KEYS: Record<RecoveryPhase, DictionaryKey> = {
  ack: "session.recovery.phase.ack",
  provider_query: "session.recovery.phase.providerQuery",
  graceful_cancel: "session.recovery.phase.gracefulCancel",
  term_grace: "session.recovery.phase.termGrace",
  kill_verify: "session.recovery.phase.killVerify",
  reconcile: "session.recovery.phase.reconcile",
  drain: "session.recovery.phase.drain",
}

const PERSISTENCE_KEYS: Record<PersistenceFact, DictionaryKey> = {
  committed: "session.recovery.value.committed",
  pending: "session.recovery.value.pending",
  unavailable: "session.recovery.value.persistenceUnavailable",
}

/**
 * What the session's owner knows, and the actions a user may take on it, while
 * the composer refuses new turns.
 *
 * It reads the owner rather than the transcript: a session whose Stop did not
 * respond has no new transcript to show, and the question a user has then —
 * "is it still running, and did anything get saved" — is answered only by the
 * three facts and the operations behind them.
 */
export function SessionRecoveryPanel(props: {
  sessionID: string
  directory?: string
  client: SessionRecoveryClient
  /** Injected so a test can age a fact without waiting for the clock. */
  now?: () => number
}) {
  const language = useLanguage()
  const now = () => props.now?.() ?? Date.now()
  const [busy, setBusy] = createSignal<"inspect" | "reconcile" | "retry">()
  const [announcement, setAnnouncement] = createSignal("")
  const [command, setCommand] = createSignal(sessionRecoveryCommand(props.sessionID))
  createEffect(() => {
    const sessionID = props.sessionID
    setCommand(sessionRecoveryCommand(sessionID))
    onCleanup(subscribeSessionRecoveryCommand(sessionID, () => setCommand(sessionRecoveryCommand(sessionID))))
  })

  const scope = () => (props.directory === undefined ? {} : { directory: props.directory })

  const read = async (): Promise<{ inspection: SessionRecoveryInspection } | { refused: RecoveryCopy }> => {
    try {
      const answer = await props.client.session.recovery.inspect({ sessionID: props.sessionID, ...scope() })
      // An owner that refuses inspection is itself the finding: it is not
      // reachable for this session, which is a different state from a session
      // whose facts are unknown.
      if (isRecoveryOutcome(answer.data)) return { refused: describeRecoveryOutcome(answer.data) }
      return { inspection: answer.data }
    } catch (error) {
      return { refused: describeRecoveryUnreachable(error instanceof Error ? error.message : String(error)) }
    }
  }

  const [inspection, { refetch }] = createResource(read)

  const current = () => {
    const value = inspection()
    return value && "inspection" in value ? value.inspection : undefined
  }
  const refusal = () => {
    const value = inspection()
    return value && "refused" in value ? value.refused : undefined
  }

  const commandCopy = () => {
    const value = command()
    if (!value) return undefined
    if (value.unreachable !== undefined) return describeRecoveryUnreachable(value.unreachable)
    return value.outcome ? describeRecoveryOutcome(value.outcome) : undefined
  }

  const inFlight = () => {
    const value = command()
    return !!value && value.outcome === undefined && value.unreachable === undefined
  }

  const lastCancellation = () =>
    current()?.operations.filter((operation) => operation.action === "cancel_turn").at(-1)

  const run = async (kind: "inspect" | "reconcile" | "retry", work: () => Promise<string>) => {
    if (busy()) return
    setBusy(kind)
    try {
      setAnnouncement(await work())
    } catch (error) {
      const copy = error instanceof RecoveryCommandFailure
        ? error.copy
        : describeRecoveryUnreachable(error instanceof Error ? error.message : String(error))
      setAnnouncement(recoveryToastText(language.t, copy).description)
    } finally {
      setBusy(undefined)
      void refetch()
    }
  }

  const inspect = () => run("inspect", async () => language.t("session.recovery.panel.inspected"))

  /**
   * Put away an answer the user has read. Only a settled command can be put
   * away: dismissing one still in flight would drop the only record that a
   * Stop is outstanding, and its answer would then arrive with nowhere to land.
   */
  const dismiss = () => {
    if (inFlight() || !commandCopy()) return
    clearSessionRecoveryCommand(props.sessionID)
    setAnnouncement(language.t("session.recovery.panel.dismissed"))
  }

  /**
   * Reconciliation is narrowed to the admitted turn because that is the only
   * owner generation inspection reports. A session-scoped request would need a
   * generation this client does not have, and an invented one is
   * indistinguishable downstream from a real one.
   */
  const reconcile = (target: RecoveryTurnTarget) =>
    run("reconcile", async () => {
      const requestId = `recovery-panel-reconcile:${crypto.randomUUID()}`
      startSessionRecoveryCommand({ sessionID: props.sessionID, requestId, action: "reconcile_session", attempt: 1 })
      const submitted = await props.client.session.recovery.submit({
        sessionID: props.sessionID,
        ...scope(),
        request: { requestId, action: "reconcile_session", target, scopeRevision: target.ownerGeneration, attempt: 1 },
      })
      settleSessionRecoveryCommand({ sessionID: props.sessionID, requestId, outcome: submitted.data })
      return recoveryToastText(language.t, describeRecoveryOutcome(submitted.data)).description
    })

  const retry = () =>
    run("retry", async () => {
      const previous = lastCancellation()
      const result = await stopRunningTurn({
        client: props.client,
        sessionID: props.sessionID,
        ...scope(),
        ...(previous ? { retryOf: { operationId: previous.operationId, attempt: previous.attempt } } : {}),
      })
      if (!result.cancelled) return language.t("session.recovery.panel.noTurn")
      return recoveryToastText(language.t, describeRecoveryOutcome(result.outcome)).description
    })

  const age = (evidence: RecoveryFactEvidence<string>) =>
    language.t("session.recovery.panel.source", {
      source: evidence.source,
      seconds: Math.max(0, Math.round((now() - evidence.observedAt) / 1000)),
    })

  return (
    <section
      class="rounded-lg border border-border-weak-base bg-background-base p-3 text-text-base"
      aria-label={language.t("session.recovery.panel.title")}
    >
      <h2 class="text-13-medium">{language.t("session.recovery.panel.title")}</h2>
      <p class="text-12-regular">{language.t("session.recovery.panel.description")}</p>

      <Show when={inFlight()}>
        <p class="text-12-regular">{language.t("session.recovery.panel.stopping")}</p>
      </Show>

      <Show when={commandCopy()} keyed>
        {(copy) => (
          <div role="status" class="text-12-regular">
            <div>{language.t(copy.titleKey)}</div>
            <div>{language.t(copy.detailKey)}</div>
            <Show when={copy.ownerMessage} keyed>
              {(message) => <pre class="whitespace-pre-wrap break-all text-12-regular">{message}</pre>}
            </Show>
          </div>
        )}
      </Show>

      <Show when={refusal()} keyed>
        {(copy) => (
          <div role="alert" class="text-12-regular">
            <div>{language.t(copy.titleKey)}</div>
            <div>{language.t(copy.detailKey)}</div>
          </div>
        )}
      </Show>

      <Show when={current()} keyed>
        {(found) => (
          <>
            <dl class="text-12-regular">
              <dt>{language.t("session.recovery.fact.execution")}</dt>
              <dd>
                {language.t(EXECUTION_KEYS[found.facts.execution.value])} <span>{age(found.facts.execution)}</span>
              </dd>
              <dt>{language.t("session.recovery.fact.cleanup")}</dt>
              <dd>
                {language.t(CLEANUP_KEYS[found.facts.cleanup.value])} <span>{age(found.facts.cleanup)}</span>
              </dd>
              <dt>{language.t("session.recovery.fact.persistence")}</dt>
              <dd>
                {language.t(PERSISTENCE_KEYS[found.facts.persistence.value])} <span>{age(found.facts.persistence)}</span>
              </dd>
            </dl>

            <p class="text-12-regular">
              {language.t("session.recovery.panel.health", { health: language.t(HEALTH_KEYS[found.health.status]) })}
            </p>
            <Show when={found.queued > 0}>
              <p class="text-12-regular">{language.t("session.recovery.panel.queued", { count: found.queued })}</p>
            </Show>

            <Show when={found.failures.length > 0}>
              <h3 class="text-12-medium">{language.t("session.recovery.panel.failures")}</h3>
              <ul class="text-12-regular">
                <For each={found.failures}>
                  {(failure) => <li>{`${failure.stage} · ${failure.code} · ${failure.message}`}</li>}
                </For>
              </ul>
            </Show>

            <Show when={found.operations.length > 0}>
              <h3 class="text-12-medium">{language.t("session.recovery.panel.operations")}</h3>
              <ul class="text-12-regular">
                <For each={found.operations}>
                  {(operation) => (
                    <li>
                      {language.t("session.recovery.panel.operation", {
                        action: language.t(ACTION_KEYS[operation.action]),
                        state: language.t(STATE_KEYS[operation.state]),
                        phase: language.t(PHASE_KEYS[operation.phase]),
                        attempt: operation.attempt,
                      })}
                      <Show when={operation.receipt === "volatile"}>
                        {" "}
                        <span>{language.t("session.recovery.panel.volatile")}</span>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>

            <div class="flex gap-2">
              <Button type="button" disabled={busy() !== undefined} onClick={() => void inspect()}>
                {language.t("session.recovery.panel.inspect")}
              </Button>
              <Show when={commandCopy()}>
                <Button type="button" disabled={busy() !== undefined} onClick={dismiss}>
                  {language.t("session.recovery.panel.dismiss")}
                </Button>
              </Show>
              <Show
                when={found.target}
                keyed
                fallback={<p class="text-12-regular">{language.t("session.recovery.panel.reconcileUnavailable")}</p>}
              >
                {(target) => (
                  <>
                    <Button type="button" disabled={busy() !== undefined} onClick={() => void reconcile(target)}>
                      {language.t("session.recovery.panel.reconcile")}
                    </Button>
                    <Button type="button" disabled={busy() !== undefined} onClick={() => void retry()}>
                      {language.t("session.recovery.panel.retry")}
                    </Button>
                  </>
                )}
              </Show>
            </div>
          </>
        )}
      </Show>

      <Show when={refusal()}>
        <Button type="button" disabled={busy() !== undefined} onClick={() => void inspect()}>
          {language.t("session.recovery.panel.inspect")}
        </Button>
      </Show>

      <p aria-live="polite" class="text-12-regular">{announcement()}</p>
    </section>
  )
}
