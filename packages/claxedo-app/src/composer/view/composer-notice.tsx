import { createContext, createEffect, createSignal, For, onCleanup, useContext, Show, type Accessor, type JSX } from "solid-js"
import { Spinner } from "@/ui"
import { useComposerText } from "../text"
import type { ComposerNotice, ComposerNoticeChannel, ComposerNoticeTone } from "./notice-slot"

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
  const source = {}
  createEffect(() => channel.publish(source, notice()))
  onCleanup(() => channel.publish(source, undefined))
}

export function ComposerNoticeRow(props: { notices: readonly ComposerNotice[]; class?: string }) {
  const t = useComposerText()
  const [expanded, setExpanded] = createSignal(false)
  const more = () => props.notices.slice(1)
  return (
    <Show when={props.notices[0]}>
      {(notice) => (
        <div class={"flex min-w-0 flex-col overflow-hidden rounded-t-xl border border-b-0 border-v2-border-border-muted bg-v2-background-bg-deep px-3 pt-2 pb-4" + (props.class ? " " + props.class : "")}>
          <ComposerNoticeCard notice={notice()} />
          <Show when={more().length > 0}>
            <Show when={expanded()} fallback={<NoticeMoreButton label={t("composer.notice.more", { count: String(more().length) })} onClick={() => setExpanded(true)} />}>
              <For each={more()}>{(other) => <ComposerNoticeCard notice={other} />}</For>
              <NoticeMoreButton label={t("composer.notice.less")} onClick={() => setExpanded(false)} />
            </Show>
          </Show>
        </div>
      )}
    </Show>
  )
}

function NoticeMoreButton(props: { label: string; onClick: () => void }) {
  return (
    <button type="button" data-action="composer-notice-more" class="self-start pl-3.5 text-12-regular text-v2-text-text-faint hover:text-v2-text-text-base" onClick={() => props.onClick()}>
      {props.label}
    </button>
  )
}

function NoticeMark(props: { tone: ComposerNoticeTone }) {
  return (
    <Show when={props.tone !== "progress"} fallback={<Spinner class="mt-px size-3 shrink-0" />}>
      <span
        aria-hidden="true"
        class="mt-[6px] size-1.5 shrink-0 rounded-full"
        classList={{
          "bg-surface-critical-strong": props.tone === "critical",
          "bg-surface-warning-strong": props.tone === "warning",
          "bg-icon-weak-base": props.tone === "info",
        }}
      />
    </Show>
  )
}

function ComposerNoticeCard(props: { notice: ComposerNotice }) {
  return (
    <div
      data-notice={props.notice.kind}
      data-tone={props.notice.tone}
      role={props.notice.tone === "critical" ? "alert" : "status"}
      aria-live={props.notice.tone === "critical" ? "assertive" : "polite"}
      title={props.notice.title ?? [props.notice.message, props.notice.detail].filter(Boolean).join(" — ")}
      class="flex min-w-0 items-start gap-2 py-0.5"
    >
      <NoticeMark tone={props.notice.tone} />
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="truncate text-12-medium text-v2-text-text-base">{props.notice.message}</span>
        <Show when={props.notice.detail}>{(detail) => <span class="line-clamp-2 text-12-regular text-v2-text-text-faint">{detail()}</span>}</Show>
      </div>
      <Show when={props.notice.action}>{(action) => <ComposerNoticeActionButton action={action()} />}</Show>
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
