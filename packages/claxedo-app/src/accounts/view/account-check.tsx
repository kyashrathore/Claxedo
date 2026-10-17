import { useAgeClock } from "@/lib/clock"
import { formatRelativeTime } from "@/lib/relative-time"
import { useI18n } from "@/i18n"
import { ClaxedoIconButton, Tooltip } from "@/ui"
import { useAccountsText } from "../i18n"
import "./account-check.css"

export function AccountCheckButton(props: { readonly checking: boolean; readonly disabled: boolean; readonly checkedAt: number | undefined; readonly onCheck: () => void }) {
  const t = useAccountsText()
  const i18n = useI18n()
  const now = useAgeClock(() => props.checkedAt)
  const hint = () => {
    const at = props.checkedAt
    return at === undefined ? t("settings.providers.agents.checkNow") : t("settings.providers.agents.checkNowAgo", { ago: formatRelativeTime(at, i18n.intlTag(), now()) })
  }
  return (
    <Tooltip value={hint()} placement="top" class="flex">
      <ClaxedoIconButton
        icon="reload"
        size="small"
        variant="ghost"
        data-action="agent-account-check"
        aria-label={t("settings.providers.agents.checkNow")}
        aria-busy={props.checking ? "true" : undefined}
        disabled={props.checking || props.disabled}
        onClick={() => props.onCheck()}
      />
    </Tooltip>
  )
}
