import { Match, Show, Switch } from "solid-js"
import type { TerminalConnection } from "../model"
import { MAX_RECONNECT_ATTEMPTS } from "../reconnect"
import { t } from "../i18n"

const BUTTON = "h-11 min-w-11 rounded-md border border-border-weak-base px-4 text-sm text-text-base hover:bg-surface-base-hover"

function Notice(props: { title: string; description?: string; action?: () => void; actionLabel?: string; testId: string }) {
  return (
    <div role="status" data-testid={props.testId} class="flex h-full items-center justify-center px-4 text-center">
      <div class="max-w-sm space-y-3">
        <div class="text-sm font-medium text-text-strong">{props.title}</div>
        <Show when={props.description}>
          <div class="text-xs text-text-weak break-words">{props.description}</div>
        </Show>
        <Show when={props.action}>
          <button type="button" class={BUTTON} onClick={() => props.action?.()}>
            {props.actionLabel}
          </button>
        </Show>
      </div>
    </div>
  )
}

export function TerminalStatus(props: {
  connection: TerminalConnection
  missing: boolean
  onRetry: () => void
  onRecreate: () => void
}) {
  return (
    <Switch>
      <Match when={props.missing}>
        <Notice title={t("terminal.missing")} testId="terminal-missing" />
      </Match>
      <Match when={props.connection.kind === "connecting"}>
        <div
          role="status"
          aria-label={t("terminal.connecting")}
          data-testid="terminal-connecting"
          class="terminal-delayed flex h-full items-center justify-center"
        >
          <div class="size-6 rounded-full border-2 border-text-weak border-t-transparent animate-spin" />
        </div>
      </Match>
      <Match when={props.connection.kind === "detached" && props.connection}>
        {(detached) => (
          <Notice
            testId="terminal-detached"
            title={t("terminal.connectionLost.title")}
            description={
              detached().attempt < MAX_RECONNECT_ATTEMPTS
                ? t("terminal.reconnecting", { attempt: detached().attempt, max: MAX_RECONNECT_ATTEMPTS })
                : detached().error.message
            }
            action={props.onRetry}
            actionLabel={t("terminal.retry")}
          />
        )}
      </Match>
      <Match when={props.connection.kind === "gone"}>
        <Notice
          testId="terminal-gone"
          title={t("terminal.gone.title")}
          description={t("terminal.gone.description")}
          action={props.onRecreate}
          actionLabel={t("terminal.recreate")}
        />
      </Match>
      <Match when={props.connection.kind === "exited" && props.connection}>
        {(exited) => (
          <Notice
            testId="terminal-exited"
            title={t("terminal.exited.title")}
            description={exited().code === undefined ? undefined : t("terminal.exited.code", { code: exited().code ?? 0 })}
            action={props.onRecreate}
            actionLabel={t("terminal.recreate")}
          />
        )}
      </Match>
    </Switch>
  )
}
