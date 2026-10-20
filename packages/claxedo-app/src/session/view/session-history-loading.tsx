import { DelayedLoading, Spinner } from "@/ui"
import { useSessionScreenText } from "./text"

export function SessionHistoryLoading() {
  const t = useSessionScreenText()
  return (
    <div role="status" aria-busy="true" data-testid="session-messages-loading" class="flex size-full items-center justify-center">
      <span class="sr-only">{t("sessionScreen.loading")}</span>
      <DelayedLoading>
        <Spinner class="size-5 text-icon-weak-base" />
      </DelayedLoading>
    </div>
  )
}
