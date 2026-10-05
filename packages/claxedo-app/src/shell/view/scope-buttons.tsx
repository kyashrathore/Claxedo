import type { JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { useTerminals } from "@/terminal"
import { shellDictionary } from "../i18n"
import { useActivePlacement } from "../active-placement"
import { useCommands } from "../palette/commands"
import { ClaxedoIcon as Icon, Tooltip } from "@/ui"

export const NEW_SESSION_COMMAND = "session.new"

const BUTTON_CLASS =
  "flex size-6 shrink-0 items-center justify-center rounded-sm text-text-weak transition-colors hover:bg-surface-base-hover hover:text-text-base"

export function ScopeButtons(): JSX.Element {
  const t = useTranslator(shellDictionary)
  const commands = useCommands()
  const terminals = useTerminals()
  const active = useActivePlacement()
  const newTerminal = () => {
    const placement = active()
    if (placement) terminals.startNew(placement)
  }
  return (
    <div class="flex shrink-0 items-center gap-0.5">
      <Tooltip value={t("shell.newSession")}>
        <button type="button" class={BUTTON_CLASS} onClick={() => commands.trigger(NEW_SESSION_COMMAND)} aria-label={t("shell.newSession")}>
          <Icon name="plus-small" size="small" />
        </button>
      </Tooltip>
      <Tooltip value={t("shell.newTerminal")}>
        <button type="button" class={BUTTON_CLASS} onClick={newTerminal} aria-label={t("shell.newTerminal")} data-testid="workspace-scope-new-terminal">
          <Icon name="terminal" size="small" />
        </button>
      </Tooltip>
    </div>
  )
}
