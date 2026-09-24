import type { JSX } from "solid-js"
import { Icon } from "@/ui"
import { useTranslator } from "@/i18n"
import { dictionary } from "../i18n"
import { GHOST_ICON_BUTTON } from "./chrome"

export function DirectoryHeader(props: {
  readonly query: string
  readonly onQuery: (value: string) => void
  readonly refreshing: boolean
  readonly onRefresh: () => void
}): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <header class="flex items-center gap-1.5">
      <input
        type="search"
        aria-label={t("marketplace.search")}
        placeholder={t("marketplace.searchPlaceholder")}
        class="min-w-56 flex-1 rounded-lg border border-border-weak-base bg-surface-base px-3 py-2 text-13-regular text-text-base"
        value={props.query}
        onInput={(event) => props.onQuery(event.currentTarget.value)}
      />
      <button
        type="button"
        aria-label={t("marketplace.refresh")}
        title={t("marketplace.refresh")}
        disabled={props.refreshing}
        class={`${GHOST_ICON_BUTTON} size-7`}
        onClick={() => props.onRefresh()}
      >
        <Icon name="reset" size="small" />
      </button>
    </header>
  )
}
