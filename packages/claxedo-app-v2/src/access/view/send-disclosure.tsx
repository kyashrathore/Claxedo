import { Button } from "@/ui/button"
import { Checkbox } from "@/ui/checkbox"
import { useTranslator } from "@/i18n"
import { dictionary } from "../i18n"
import type { ShareFormState } from "../model"

export function SendDisclosure(props: {
  readonly state: Extract<ShareFormState, { kind: "confirmingSend" }>
  readonly onAcknowledge: (acknowledged: boolean) => void
  readonly onConfirm: () => void
  readonly onCancel: () => void
}) {
  const t = useTranslator(dictionary)
  return (
    <div role="alertdialog" aria-label={t("access.share.disclosure.title")} class="share-disclosure">
      <div class="share-title">{t("access.share.disclosure.title")}</div>
      <p class="share-intro">{t("access.share.disclosure.body")}</p>
      <Checkbox checked={props.state.acknowledged} onChange={(checked: boolean) => props.onAcknowledge(checked)}>
        {t("access.share.disclosure.acknowledge")}
      </Checkbox>
      <div class="share-actions">
        <Button
          size="small"
          disabled={!props.state.acknowledged}
          aria-label={`${t("access.share.disclosure.confirm")}: ${props.state.request.description}`}
          onClick={() => props.onConfirm()}
        >
          {t("access.share.disclosure.confirm")}
        </Button>
        <Button size="small" variant="ghost" onClick={() => props.onCancel()}>
          {t("access.share.cancel")}
        </Button>
      </div>
    </div>
  )
}
