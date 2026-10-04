import {
  createContext,
  createEffect,
  createSignal,
  onCleanup,
  useContext,
  Show,
  type Accessor,
  type JSX,
} from "solid-js"

export type ComposerNoticeTone = "critical" | "warning" | "info"

export type ComposerNotice = {
  kind: string
  tone: ComposerNoticeTone
  message: string
  detail?: string
  title?: string
  action?: { label: string; ariaLabel?: string; run: () => void }
}

export type ComposerNoticeChannel = {
  current: Accessor<ComposerNotice | undefined>
  publish: (notice: ComposerNotice | undefined) => void
}

export function createComposerNoticeChannel(): ComposerNoticeChannel {
  const [current, setCurrent] = createSignal<ComposerNotice | undefined>()
  return { current, publish: (notice) => setCurrent(() => notice) }
}

const ComposerNoticeContext = createContext<ComposerNoticeChannel>()

export function ComposerNoticeProvider(props: { channel: ComposerNoticeChannel; children: JSX.Element }) {
  return <ComposerNoticeContext.Provider value={props.channel}>{props.children}</ComposerNoticeContext.Provider>
}

export function useComposerNoticeChannel() {
  return useContext(ComposerNoticeContext)
}

export function publishComposerNotice(notice: Accessor<ComposerNotice | undefined>) {
  const channel = useComposerNoticeChannel()
  if (!channel) return
  createEffect(() => channel.publish(notice()))
  onCleanup(() => channel.publish(undefined))
}

export function ComposerNoticeRow(props: { notice: ComposerNotice | undefined; class?: string }) {
  return (
    <Show when={props.notice}>
      {(notice) => <ComposerNoticeCard notice={notice()} class={props.class} />}
    </Show>
  )
}

function ComposerNoticeCard(props: { notice: ComposerNotice; class?: string }) {
  return (
    <div
      data-notice={props.notice.kind}
      data-tone={props.notice.tone}
      role={props.notice.tone === "critical" ? "alert" : "status"}
      aria-live={props.notice.tone === "critical" ? "assertive" : "polite"}
      title={props.notice.title ?? [props.notice.message, props.notice.detail].filter(Boolean).join(" — ")}
      class={
        "flex min-w-0 items-start gap-2 overflow-hidden rounded-t-xl border border-b-0 border-v2-border-border-muted bg-v2-background-bg-deep px-3 pt-2 pb-4" +
        (props.class ? " " + props.class : "")
      }
    >
      <span
        aria-hidden="true"
        class="mt-[6px] size-1.5 shrink-0 rounded-full"
        classList={{
          "bg-surface-critical-strong": props.notice.tone === "critical",
          "bg-surface-warning-strong": props.notice.tone === "warning",
          "bg-icon-weak-base": props.notice.tone === "info",
        }}
      />
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="truncate text-12-medium text-v2-text-text-base">
          {props.notice.message}
        </span>
        <Show when={props.notice.detail}>
          {(detail) => (
            <span
              class="line-clamp-2 text-12-regular text-v2-text-text-faint"
            >
              {detail()}
            </span>
          )}
        </Show>
      </div>
      <Show when={props.notice.action}>
        {(action) => <ComposerNoticeActionButton action={action()} />}
      </Show>
    </div>
  )
}

function ComposerNoticeActionButton(props: { action: NonNullable<ComposerNotice["action"]> }) {
  return (
    <button
      type="button"
      data-action="composer-notice-action"
      aria-label={props.action.ariaLabel ?? props.action.label}
      class="inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-12-medium text-v2-text-text-base transition-colors duration-150 hover:bg-surface-raised-strong focus:outline-none focus:ring-1 focus:ring-border-interactive-focus"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        props.action.run()
      }}
    >
      {props.action.label}
    </button>
  )
}
