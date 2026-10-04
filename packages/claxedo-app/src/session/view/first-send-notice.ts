import { publishComposerNotice, type ComposerNotice } from "@/composer"
import type { WhereNew } from "@/projects"
import type { FirstSendState } from "./first-send"
import { usePlacementNotice } from "./placement-notice"
import { useSessionScreenText, type SessionScreenText } from "./text"

function creatingLabel(t: SessionScreenText, choice: WhereNew) {
  return choice.kind === "newCloud" ? t("sessionScreen.firstSend.creatingCloud", { name: choice.name }) : t("sessionScreen.firstSend.creatingWorktree")
}

export function FirstSendNotice(props: { readonly state: FirstSendState; readonly onRetry: () => void }) {
  const t = useSessionScreenText()
  const placement = usePlacementNotice(() => (props.state.kind === "sending" ? props.state.placementId : undefined))
  publishComposerNotice((): ComposerNotice | undefined => {
    const state = props.state
    if (state.kind === "creating") return { kind: "first-send", tone: "progress", message: creatingLabel(t, state.choice) }
    if (state.kind === "failed") {
      return { kind: "first-send", tone: "critical", message: t("sessionScreen.firstSend.failed"), detail: state.error.message, action: { label: t("sessionScreen.action.retry"), run: props.onRetry } }
    }
    return state.kind === "sending" ? placement() : undefined
  })
  return null
}
