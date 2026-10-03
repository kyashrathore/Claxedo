import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { ClaxedoIcon as Icon } from "@/ui"
import { railDictionary } from "../i18n"

export type SessionListNoticeVariant = "loading" | "error" | "empty" | "done"

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
