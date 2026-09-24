import { For, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { Button } from "@/ui"
import { dictionary } from "../i18n"
import type { BrowserConsoleEntry, BrowserConsoleLevel } from "../model"
import type { BrowserTab } from "../tab"

const VISIBLE_ENTRIES = 100

const LEVEL_CLASS: Record<BrowserConsoleLevel, string> = {
  error: "text-danger-fg",
  warn: "text-warning-fg",
  debug: "text-text-muted",
  info: "text-text-muted",
  log: "text-text-base",
}

function ConsoleRow(props: { readonly entry: BrowserConsoleEntry }): JSX.Element {
  return (
    <li class="flex items-start gap-2 px-2 py-1 font-mono text-xs">
      <span class={`w-12 shrink-0 uppercase tracking-wider ${LEVEL_CLASS[props.entry.level]}`}>
        {props.entry.level}
      </span>
      <span class="min-w-0 flex-1 whitespace-pre-wrap break-words text-text-base">{props.entry.args.join(" ")}</span>
    </li>
  )
}

export function ConsoleDrawer(props: { readonly tab: BrowserTab }): JSX.Element {
  const t = useTranslator(dictionary)
  const entries = () => props.tab.log()
  const visible = () => entries().slice(-VISIBLE_ENTRIES)
  return (
    <Show when={props.tab.consoleOpen()}>
      <section
        aria-label={t("browser.console")}
        class="flex max-h-[40%] min-h-32 shrink-0 flex-col border-t border-border-muted bg-background-base"
      >
        <div class="flex h-9 shrink-0 items-center justify-between px-2">
          <div class="flex items-center gap-2 text-sm font-medium text-text-base">
            <span>{t("browser.console")}</span>
            <span class="tabular-nums text-text-muted">{entries().length}</span>
          </div>
          <Button variant="ghost" size="small" disabled={entries().length === 0} onClick={() => props.tab.clearLog()}>
            {t("browser.console.clear")}
          </Button>
        </div>
        <Show
          when={entries().length > 0}
          fallback={
            <p class="flex flex-1 items-center justify-center px-3 py-4 text-sm text-text-muted">
              {t("browser.console.empty")}
            </p>
          }
        >
          <ul class="flex-1 divide-y divide-border-muted overflow-auto">
            <For each={visible()}>{(entry) => <ConsoleRow entry={entry} />}</For>
          </ul>
        </Show>
      </section>
    </Show>
  )
}
