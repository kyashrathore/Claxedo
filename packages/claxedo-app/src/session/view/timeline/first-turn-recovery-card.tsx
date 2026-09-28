import { createSignal, Show, type ParentProps } from "solid-js"
import { copyText } from "@/lib/clipboard"
import { ClaxedoIcon as Icon, Button, Card, Tooltip } from "@/ui"
import { ClaxedoIconButton as IconButton } from "@/ui"
import type { DispatchContext } from "./provider-error-detail"
import type { TimelineTranslate } from "./model"
import { turnRecoveryKeys, sessionRecoveryAccount, sessionRecoveryDescription, sessionRecoveryTitle, type SessionErrorClass } from "./turn-recovery"

function RawDetail(props: { detail: string }) {
  const [open, setOpen] = createSignal(false)
  const [copied, setCopied] = createSignal(false)

  const copy = async () => {
    if (!(await copyText(props.detail)).copied) return
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div class="mt-2 min-w-0">
      <div class="group flex min-w-0 items-center gap-1">
        <button
          type="button"
          class="flex min-h-6 min-w-0 flex-1 items-center gap-1 text-left"
          aria-expanded={open()}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon
            name="chevron-right"
            size="small"
            class="shrink-0 text-icon-weak-base transition-transform duration-150"
            style={{ transform: open() ? "rotate(90deg)" : "rotate(0deg)" }}
          />
          <span class="min-w-0 flex-1 line-clamp-2 break-words font-mono text-12-regular text-text-weaker">
            {open() ? "Error details" : props.detail}
          </span>
        </button>
        <Show when={open()}>
          <Tooltip value={copied() ? "Copied" : "Copy error"} placement="top" gutter={4}>
            <IconButton
              icon={copied() ? "check" : "copy"}
              size="small"
              variant="ghost"
              data-icon-interaction="subdued"
              onMouseDown={(e: MouseEvent) => e.preventDefault()}
              onClick={(e: MouseEvent) => {
                e.stopPropagation()
                void copy()
              }}
              aria-label={copied() ? "Copied" : "Copy error"}
            />
          </Tooltip>
        </Show>
      </div>
      <Show when={open()}>
        <div class="mt-1 whitespace-pre-wrap break-words pl-5 font-mono text-12-regular text-text-weaker select-text">
          {props.detail}
        </div>
      </Show>
    </div>
  )
}

function InlineErrorStatus(props: ParentProps<{
  testId: string
  title: string
  description: string
  recoveryClass?: SessionErrorClass
}>) {
  return (
    <div
      role="status"
      data-testid={props.testId}
      data-recovery-class={props.recoveryClass}
      class="mt-2 flex items-start gap-2 px-1 py-1 text-text-weaker"
    >
      <Icon name="circle-alert" size="small" class="mt-0.5 shrink-0 text-icon-weak-base" />
      <div class="min-w-0 flex-1">
        <div class="text-12-regular">{props.title}</div>
        <div class="mt-0.5 text-12-regular">{props.description}</div>
        {props.children}
      </div>
    </div>
  )
}

function TurnAdmissionStatus(props: { summary?: string }) {
  return (
    <InlineErrorStatus
      testId="turn-admission-status-message"
      title="Message wasn’t sent"
      description={props.summary ?? "The previous message was still finishing. Try again."}
    />
  )
}

export function TimelineErrorPresentation(props: {
  presentation?: "turn-conflict"
  recoveryClass?: SessionErrorClass
  text: string
  summary?: string
  error?: unknown
  providerId?: string
  modelId?: string
  onAction: (value: SessionErrorClass) => unknown
  t: TimelineTranslate
}) {
  return (
    <Show
      when={props.presentation === "turn-conflict"}
      fallback={
        <Show
          when={props.recoveryClass}
          fallback={<Card variant="error" class="error-card">{props.summary ?? props.text}</Card>}
        >
          {(kind) => (
            <FirstTurnRecoveryCard
              kind={kind()}
              detail={props.text}
              summary={props.summary}
              error={props.error}
              providerId={props.providerId}
              modelId={props.modelId}
              onAction={props.onAction}
              t={props.t}
            />
          )}
        </Show>
      }
    >
      <TurnAdmissionStatus summary={props.summary} />
    </Show>
  )
}

function FirstTurnRecoveryCard(props: {
  kind: SessionErrorClass
  detail?: string
  summary?: string
  error?: unknown
  providerId?: string
  modelId?: string
  onAction: (kind: SessionErrorClass) => unknown
  t: TimelineTranslate
}) {
  const dispatch = (): DispatchContext => ({ providerID: props.providerId, modelID: props.modelId })
  const text = () => turnRecoveryKeys(props.kind)
  const title = () => sessionRecoveryTitle(props.kind, props.error, dispatch()) ?? props.t(text().title)
  const description = () =>
    props.summary ?? sessionRecoveryDescription(props.kind, props.error, dispatch()) ?? props.t(text().description)
  const account = () => {
    const named = sessionRecoveryAccount(props.error)
    return named && props.t(named.key, named.params)
  }
  const accountLine = <Show when={account()}>{(value) => <div class="mt-0.5 text-12-regular">{value()}</div>}</Show>
  if (props.kind === "usage_limit") {
    return (
      <InlineErrorStatus
        testId="usage-limit-status-message"
        recoveryClass={props.kind}
        title={title()}
        description={description()}
      >
        {accountLine}
      </InlineErrorStatus>
    )
  }
  const detail = () => {
    const value = props.detail?.trim()
    if (!value || value === description().trim()) return undefined
    return value
  }
  const [pending, setPending] = createSignal(false)
  const [actionError, setActionError] = createSignal<string>()
  const act = async () => {
    if (pending()) return
    setActionError(undefined)
    setPending(true)
    try {
      await props.onAction(props.kind)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not continue with another model")
    } finally {
      setPending(false)
    }
  }

  return (
    <InlineErrorStatus
      testId="first-turn-recovery-card"
      recoveryClass={props.kind}
      title={title()}
      description={description()}
    >
      {accountLine}
      <Show when={detail()}>{(value) => <RawDetail detail={value()} />}</Show>
      <Show when={actionError()}>{(value) => (
        <div class="mt-2 text-12-regular text-icon-critical-base" role="alert">{value()}</div>
      )}</Show>
      <Show when={text().action}>
        {(action) => (
          <Button
            class="mt-2"
            size="small"
            variant="neutral"
            disabled={pending()}
            aria-busy={pending()}
            onClick={() => void act()}
          >
            {props.t(action())}
          </Button>
        )}
      </Show>
    </InlineErrorStatus>
  )
}
