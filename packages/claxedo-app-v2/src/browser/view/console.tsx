import { For, Show, type JSX } from "solid-js"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useTranslator } from "@/i18n"
import { ClaxedoIcon as Icon, ClaxedoIconButton as IconButton } from "@/ui"
import { dictionary } from "../i18n"
import type { BrowserConsoleEntry } from "../model"
import type { BrowserTab } from "../tab"

function ConsoleRow(props: { readonly entry: BrowserConsoleEntry }): JSX.Element {
  const level = () => props.entry.level
  return (
    <li class="flex items-start gap-2 px-2 py-1 text-12-mono">
      <span
        class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
        classList={{
          "bg-surface-critical-strong": level() === "error",
          "bg-surface-warning-strong": level() === "warn",
          "bg-text-weak": level() === "debug" || level() === "info",
          "bg-text-base": level() === "log",
        }}
        aria-hidden="true"
      />
      <span
        class="w-12 shrink-0 text-12-medium uppercase tracking-wider"
        classList={{
          "text-surface-critical-strong": level() === "error",
          "text-surface-warning-strong": level() === "warn",
          "text-text-weak": level() === "debug" || level() === "info",
          "text-text-base": level() === "log",
        }}
      >
        {level()}
      </span>
      <span class="flex-1 whitespace-pre-wrap break-words text-text-base">{props.entry.args.join(" ")}</span>
    </li>
  )
}

function ConsoleHeader(props: { readonly tab: BrowserTab }): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <div class="flex h-8 shrink-0 items-center justify-between border-b border-border-weak-base px-2">
      <div class="flex items-center gap-2 text-12-medium text-text-base">
        <Icon name="terminal" size="small" class="text-text-weak" />
        <span>{t("browser.console")}</span>
        <span class="text-text-weak tabular-nums">{props.tab.log().length}</span>
      </div>
      <div class="flex items-center gap-0.5">
        <Tooltip value={t("browser.console.devTools")} placement="bottom">
          <IconButton
            icon="open-external"
            variant="ghost"
            size="small"
            aria-label={t("browser.devTools")}
            onClick={() => void props.tab.act("devTools")}
            data-testid="browser-pane-console-open-devtools"
          />
        </Tooltip>
        <Tooltip value={t("browser.console.clear")} placement="bottom">
          <IconButton
            icon="close-small"
            variant="ghost"
            size="small"
            aria-label={t("browser.console.clear")}
            disabled={props.tab.log().length === 0}
            onClick={() => props.tab.clearLog()}
            data-testid="browser-pane-console-clear"
          />
        </Tooltip>
      </div>
    </div>
  )
}

export function ConsoleDrawer(props: { readonly tab: BrowserTab }): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <div
      classList={{
        "flex flex-col border-t border-border-weak-base bg-background-base": true,
        hidden: !props.tab.consoleOpen(),
      }}
      data-testid="browser-pane-console-drawer"
      style={{ "max-height": "40%", "min-height": "120px" }}
    >
      <ConsoleHeader tab={props.tab} />
      <Show
        when={props.tab.log().length > 0}
        fallback={
          <div class="flex flex-1 items-center justify-center px-3 py-4 text-12-regular text-text-weak">
            {t("browser.console.empty")}
          </div>
        }
      >
        <ul class="flex-1 overflow-auto divide-y divide-border-weak-base">
          <For each={props.tab.log()}>{(entry) => <ConsoleRow entry={entry} />}</For>
        </ul>
      </Show>
    </div>
  )
}
