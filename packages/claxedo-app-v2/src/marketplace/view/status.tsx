import type { JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { marketplaceDictionary } from "../i18n"
import type { PluginStatus } from "../model"

export function PluginStatusLine(props: { readonly status: PluginStatus; readonly wrap?: boolean }): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  return (
    <span
      data-component="agent-plugin-status"
      data-tone={props.status.tone}
      class="inline-flex min-w-0 max-w-full gap-1.5"
      classList={{ "items-center": !props.wrap, "items-baseline": props.wrap }}
    >
      <span
        class="size-1.5 shrink-0 rounded-full"
        classList={{
          "bg-surface-success-strong": props.status.tone === "normal",
          "bg-surface-warning-strong": props.status.tone === "warning",
          "bg-surface-critical-strong": props.status.tone === "critical",
          "bg-surface-interactive-base": props.status.tone === "accent",
        }}
      />
      <span
        class="text-12-regular"
        classList={{
          truncate: !props.wrap,
          "text-text-weak": props.status.tone === "normal",
          "text-icon-warning-base": props.status.tone === "warning",
          "text-icon-critical-base": props.status.tone === "critical",
          "text-text-interactive-base": props.status.tone === "accent",
        }}
      >
        {t(props.status.key, props.status.params)}
      </span>
    </span>
  )
}
