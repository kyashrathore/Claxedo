import { createSignal, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { sessionRecovery, sessionRecoveryDescription, type SessionErrorClass } from "./first-turn-recovery"

// Raw-detail disclosure: collapsed by default, chevron-gated, copyable when open.
// Mirrors the pattern in packages/session-ui/src/components/tool-error-card.tsx:128-149.
function RawDetail(props: { detail: string }) {
  const [open, setOpen] = createSignal(false)
  const [copied, setCopied] = createSignal(false)

  const copy = async () => {
    await navigator.clipboard.writeText(props.detail)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div class="mt-1 min-w-0">
      <div class="group flex min-w-0 items-start gap-1">
        <button
          type="button"
          class="flex min-w-0 flex-1 items-start gap-1 text-left"
          aria-expanded={open()}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon
            name="chevron-right"
            size="small"
            class="mt-0.5 shrink-0 text-icon-weak-base transition-transform duration-150"
            style={{ transform: open() ? "rotate(90deg)" : "rotate(0deg)" }}
          />
          <span class="min-w-0 flex-1 line-clamp-2 break-words font-mono text-12-regular text-text-weaker">{props.detail}</span>
        </button>
        <Show when={open()}>
          <Tooltip value={copied() ? "Copied" : "Copy error"} placement="top" gutter={4}>
            <IconButton
              icon={copied() ? "check" : "copy"}
              size="normal"
              variant="ghost"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation()
                void copy()
              }}
              aria-label={copied() ? "Copied" : "Copy error"}
            />
          </Tooltip>
        </Show>
      </div>
      <Show when={open()}>
        <div class="mt-1 whitespace-pre-wrap break-words pl-[20px] font-mono text-12-regular text-text-weaker select-text">
          {props.detail}
        </div>
      </Show>
    </div>
  )
}

export function FirstTurnRecoveryCard(props: {
  kind: SessionErrorClass
  detail?: string
  /**
   * The already-composed human sentence. Passed in by the timeline so the
   * first paint is readable; the card only derives it when a caller has none.
   */
  summary?: string
  /** The raw wire error, so the description can name the provider's own status. */
  error?: unknown
  providerID?: string
  modelID?: string
  onAction: (kind: SessionErrorClass) => unknown
}) {
  const recovery = () => sessionRecovery(props.kind)
  const description = () =>
    props.summary ??
    sessionRecoveryDescription(props.kind, props.error, { providerID: props.providerID, modelID: props.modelID })
  const [pending, setPending] = createSignal(false)
  const act = async () => {
    if (pending()) return
    setPending(true)
    try {
      await props.onAction(props.kind)
    } finally {
      setPending(false)
    }
  }

  return (
    <div class="rounded-lg border border-border-weak-base bg-transparent px-4 py-3" data-testid="first-turn-recovery-card" data-recovery-class={props.kind}>
      <div class="flex items-start gap-3">
        <Icon name="warning" class="mt-0.5 size-4 shrink-0 text-icon-warning-base" />
        <div class="min-w-0 flex-1">
          <div class="text-14-medium text-text-strong">{recovery().title}</div>
          <div class="mt-1 text-13-regular text-text-base">{description()}</div>
          <Show when={props.detail}>{(detail) => <RawDetail detail={detail()} />}</Show>
          <Button
            class="mt-3"
            size="small"
            variant="secondary"
            disabled={pending()}
            aria-busy={pending()}
            onClick={() => void act()}
          >
            {recovery().label}
          </Button>
        </div>
      </div>
    </div>
  )
}
