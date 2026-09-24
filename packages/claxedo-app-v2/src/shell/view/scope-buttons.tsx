import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { useTerminals } from "@/terminal"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { dictionary } from "../i18n"
import { useActivePlacement } from "../active-placement"
import { useShellLayout } from "../layout"
import { useCommands } from "../palette/commands"

export const NEW_SESSION_COMMAND = "session.new"

const BUTTON_CLASS =
  "flex size-6 shrink-0 items-center justify-center rounded-sm text-text-weak transition-colors hover:bg-surface-base-hover hover:text-text-base"

export function ScopeButtons(): JSX.Element {
  const t = useTranslator(dictionary)
  const commands = useCommands()
  const terminals = useTerminals()
  const active = useActivePlacement()
  const layout = useShellLayout()
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
      <Show when={!layout.phone()}>
        <Tooltip value={t("shell.newTerminal")}>
          <button type="button" class={BUTTON_CLASS} onClick={newTerminal} aria-label={t("shell.newTerminal")} data-testid="workspace-scope-new-terminal">
            <Icon name="terminal" size="small" />
          </button>
        </Tooltip>
      </Show>
    </div>
  )
}
