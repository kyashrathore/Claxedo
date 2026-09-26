import { createEffect, on, Show, type Accessor, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { showToast } from "@/ui"
import { terminalDictionary, type TerminalKey } from "../i18n"
import type { TerminalConnection, TerminalFailure } from "../model"

type FailureToast = { readonly title: TerminalKey; readonly description?: TerminalKey }

const FAILURE_TOAST: Readonly<Record<Exclude<TerminalFailure, "start">, FailureToast>> = {
  closed: { title: "terminal.connectionLost.title" },
  overload: { title: "terminal.overload.title", description: "terminal.overload" },
  restore: { title: "terminal.restoreFailed" },
}

export function useConnectionToasts(connection: Accessor<TerminalConnection>): void {
  const t = useTranslator(terminalDictionary)
  createEffect(
    on(connection, (current) => {
      if (current.kind !== "failed" || current.failure === "start") return
      const toast = FAILURE_TOAST[current.failure]
      const fallback = current.failure === "closed" ? t("terminal.connectionLost.description") : undefined
      showToast({
        variant: "error",
        title: t(toast.title),
        description: toast.description ? t(toast.description) : current.error.message || fallback,
      })
    }),
  )
}

export function TerminalStatus(props: {
  readonly connection: TerminalConnection
  readonly onRetry: () => void
}): JSX.Element {
  const t = useTranslator(terminalDictionary)
  const startFailure = () =>
    props.connection.kind === "failed" && props.connection.failure === "start" ? props.connection.error.message : undefined
  return (
    <Show
      when={startFailure() !== undefined}
      fallback={
        <div data-testid="terminal-connecting" class="flex items-center justify-center h-full text-text-weak">
          <div class="size-6 rounded-full border-2 border-text-weak border-t-transparent animate-spin" />
        </div>
      }
    >
      <div data-testid="terminal-failed" class="flex h-full items-center justify-center px-4 text-center">
        <div class="max-w-sm space-y-3">
          <div class="text-sm font-medium text-text-strong">{t("terminal.startFailed.title")}</div>
          <div class="text-xs text-text-weak break-words">{startFailure()}</div>
          <button
            type="button"
            class="h-10 rounded-md border border-border-weak-base px-4 text-sm text-text-base hover:bg-surface-base-hover active:scale-[0.96]"
            onClick={() => props.onRetry()}
          >
            {t("terminal.retry")}
          </button>
        </div>
      </div>
    </Show>
  )
}
