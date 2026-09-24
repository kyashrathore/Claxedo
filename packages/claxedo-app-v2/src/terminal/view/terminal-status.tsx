import { Match, Show, Switch, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { Button, Spinner } from "@/ui"
import { dictionary, type TerminalKey } from "../i18n"
import type { TerminalConnection, TerminalFailure } from "../model"
import { MAX_RECONNECT_ATTEMPTS } from "../reconnect"

const FAILURE_TEXT: Record<TerminalFailure, TerminalKey> = {
  closed: "terminal.connectionLost.description",
  overload: "terminal.overload",
  restore: "terminal.restoreFailed",
  start: "terminal.startFailed",
}

function Notice(props: {
  readonly title: string
  readonly description?: string
  readonly action?: () => void
  readonly actionLabel?: string
  readonly testId: string
}): JSX.Element {
  return (
    <div role="status" data-testid={props.testId} class="flex h-full items-center justify-center px-4 text-center">
      <div class="flex max-w-sm flex-col items-center gap-3">
        <div class="text-base font-medium text-text-base">{props.title}</div>
        <Show when={props.description}>
          <div class="text-sm break-words text-text-muted">{props.description}</div>
        </Show>
        <Show when={props.action}>
          <Button variant="secondary" size="large" onClick={() => props.action?.()}>
            {props.actionLabel}
          </Button>
        </Show>
      </div>
    </div>
  )
}

export function TerminalStatus(props: {
  readonly connection: TerminalConnection
  readonly onRetry: () => void
}): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <Switch>
      <Match when={props.connection.kind === "connecting"}>
        <div
          role="status"
          aria-label={t("terminal.connecting")}
          data-testid="terminal-connecting"
          class="terminal-delayed flex h-full items-center justify-center text-icon-muted"
        >
          <Spinner class="size-6" />
        </div>
      </Match>
      <Match when={props.connection.kind === "detached" && props.connection}>
        {(detached) => (
          <Notice
            testId="terminal-detached"
            title={t("terminal.connectionLost.title")}
            description={t("terminal.reconnecting", { attempt: detached().attempt, max: MAX_RECONNECT_ATTEMPTS })}
            action={props.onRetry}
            actionLabel={t("terminal.retry")}
          />
        )}
      </Match>
      <Match when={props.connection.kind === "failed" && props.connection}>
        {(failed) => (
          <Notice
            testId="terminal-failed"
            title={failed().failure === "closed" ? t("terminal.connectionLost.title") : t("terminal.failed.title")}
            description={t(FAILURE_TEXT[failed().failure])}
            action={props.onRetry}
            actionLabel={t("terminal.retry")}
          />
        )}
      </Match>
    </Switch>
  )
}
