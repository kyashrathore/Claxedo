import { For, Show } from "solid-js"
import { t } from "../i18n"
import type { BrowserConsoleEntry } from "../model"
import type { BrowserTab } from "../tab"
import { toolbarButtonClass } from "./toolbar"

const VISIBLE_ENTRIES = 100

function ConsoleRow(props: { readonly entry: BrowserConsoleEntry }) {
  const level = () => props.entry.level
  return (
    <li class="flex items-start gap-2 px-2 py-1 font-mono text-12-regular">
      <span
        class="w-12 shrink-0 uppercase tracking-wider"
        classList={{
          "text-surface-critical-strong": level() === "error",
          "text-surface-warning-strong": level() === "warn",
          "text-text-weak": level() === "debug" || level() === "info",
          "text-text-base": level() === "log",
        }}
      >
        {level()}
      </span>
      <span class="min-w-0 flex-1 whitespace-pre-wrap break-words text-text-base">{props.entry.args.join(" ")}</span>
    </li>
  )
}

export function ConsoleDrawer(props: { readonly tab: BrowserTab }) {
  const entries = () => props.tab.log()
  const visible = () => entries().slice(-VISIBLE_ENTRIES)
  return (
    <Show when={props.tab.consoleOpen()}>
      <section aria-label={t("browser.console")} class="flex max-h-[40%] min-h-32 flex-col border-t border-border-weak-base bg-background-base">
        <div class="flex h-8 shrink-0 items-center justify-between px-2">
          <div class="flex items-center gap-2 text-12-medium text-text-base">
            <span>{t("browser.console")}</span>
            <span class="tabular-nums text-text-weak">{entries().length}</span>
          </div>
          <button
            type="button"
            class={toolbarButtonClass}
            aria-label={t("browser.console.clear")}
            disabled={entries().length === 0}
            onClick={() => props.tab.clearLog()}
          >
            {t("browser.console.clear")}
          </button>
        </div>
        <Show
          when={entries().length > 0}
          fallback={<div class="flex flex-1 items-center justify-center px-3 py-4 text-12-regular text-text-weak">{t("browser.console.empty")}</div>}
        >
          <ul class="flex-1 divide-y divide-border-weak-base overflow-auto">
            <For each={visible()}>{(entry) => <ConsoleRow entry={entry} />}</For>
          </ul>
        </Show>
      </section>
    </Show>
  )
}
