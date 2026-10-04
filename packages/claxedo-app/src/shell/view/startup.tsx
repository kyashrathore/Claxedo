import { Show, type JSX } from "solid-js"
import { useErrorCopy, useTranslator } from "@/i18n"
import { FailureNotice } from "@/lib/failure"
import { useServer } from "@/server"
import { ClaxedoSplash, DelayedLoading } from "@/ui"
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
    <main class="fixed inset-0 z-[9999] flex h-dvh w-full flex-col items-center justify-center bg-background-base p-4">
      <Show when={failure()} fallback={
        <div role="status" aria-label={t("shell.loading")} data-testid="shell-loading">
          <DelayedLoading>
            <ClaxedoSplash class="w-16 h-20 opacity-50" />
          </DelayedLoading>
        </div>
      }>
        {(error) => <FailureNotice title={copy(error()).title} message={error().message} retryLabel={t("shell.retry")} onRetry={() => void server.retryConnection()} />}
      </Show>
    </main>
  )
}
