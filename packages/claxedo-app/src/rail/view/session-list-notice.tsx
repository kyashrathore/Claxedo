import { Index, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { ClaxedoIcon as Icon, DelayedLoading, SkeletonBar } from "@/ui"
import { railDictionary } from "../i18n"

export type SessionListNoticeVariant = "error" | "empty" | "done"

export function SessionListNotice(props: {
  readonly variant: SessionListNoticeVariant
  readonly children: JSX.Element
  readonly actionLabel?: string
  readonly onAction?: () => void
}): JSX.Element {
  return (
    <div
      data-testid={`rail-sidebar-session-list-${props.variant}`}
      class="flex items-center gap-2 pl-9 pr-2.5 py-1 text-xs"
      classList={{ "text-text-weaker": props.variant !== "error", "text-text-base": props.variant === "error" }}
    >
      <Show when={props.variant === "error"}>
        <Icon name="warning" size="small" class="shrink-0 text-icon-critical-base" />
      </Show>
      <span class="min-w-0 flex-1">{props.children}</span>
      <Show when={props.actionLabel && props.onAction}>
        <button
          type="button"
          class="shrink-0 text-xs text-text-weak hover:text-text-base transition-colors duration-100"
          onClick={(event) => {
            event.stopPropagation()
            props.onAction?.()
          }}
        >
          {props.actionLabel}
        </button>
      </Show>
    </div>
  )
}

export function SessionLoadMore(props: { readonly loading: boolean; readonly onLoad: () => void }): JSX.Element {
  const t = useTranslator(railDictionary)
  return (
    <button
      data-testid="rail-sidebar-session-load-more"
      type="button"
      class="text-sm text-text-weaker hover:text-text-weak pl-9 pr-2.5 py-1 text-left transition-colors duration-100"
      disabled={props.loading}
      classList={{ "opacity-60": props.loading }}
      onClick={(event) => {
        props.onLoad()
        event.currentTarget.blur()
      }}
    >
      {props.loading ? t("rail.loadingMore") : t("rail.loadMore")}
    </button>
  )
}

const LOADING_TITLES = ["72%", "54%", "64%"] as const

export function SessionRowsLoading(): JSX.Element {
  const t = useTranslator(railDictionary)
  return (
    <div role="status" aria-label={t("rail.loadingSessions")} data-testid="rail-sidebar-session-list-loading" class="flex flex-col gap-0.5">
      <DelayedLoading>
        <Index each={LOADING_TITLES}>
          {(width) => (
            <div aria-hidden="true" class="mx-1 flex flex-col gap-1.5 py-2 pl-9 pr-2.5">
              <SkeletonBar width={width()} class="h-2.5" />
              <SkeletonBar width="36%" class="h-2" />
            </div>
          )}
        </Index>
      </DelayedLoading>
    </div>
  )
}
