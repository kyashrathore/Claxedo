import { Show, type JSX } from "solid-js"
import { useErrorCopy, useTranslator } from "@/i18n"
import { FailureNotice } from "@/lib/failure"
import { useServer } from "@/server"
import { shellDictionary } from "../i18n"

export function ShellStartup(): JSX.Element {
  const server = useServer()
  const copy = useErrorCopy()
  const t = useTranslator(shellDictionary)
  const failure = () => {
    const state = server.startup()
    return state.kind === "failed" ? state.failure : undefined
  }
  return (
    <Show when={failure()} fallback={<main class="startup-shell" role="status" aria-label={t("shell.loading")} data-testid="shell-loading" />}>
      {(error) => (
        <main class="fixed inset-0 z-[9999] flex h-dvh w-full flex-col items-center justify-center bg-background-base p-4">
          <FailureNotice title={copy(error()).title} message={error().message} retryLabel={t("shell.retry")} onRetry={() => void server.retryConnection()} />
        </main>
      )}
    </Show>
  )
}
