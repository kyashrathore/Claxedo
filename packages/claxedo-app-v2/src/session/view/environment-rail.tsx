import { SemanticIcon } from "@/ui"
import { useSessionScreenText } from "./text"
import "./environment-rail.css"

export type EnvironmentNavigator = "changes" | "files"

export function EnvironmentRail(props: { readonly onOpen: (navigator: EnvironmentNavigator) => void }) {
  const t = useSessionScreenText()
  return (
    <aside data-surface="context-card" class="ui-context-card is-floating is-collapsed session-envcard" aria-label={t("sessionScreen.environment.label")}>
      <div class="ui-context-card-rail">
        <button
          type="button"
          data-icon-interaction="standalone"
          class="ui-context-card-rail-item"
          aria-label={t("sessionScreen.environment.openChanges")}
          onClick={() => props.onOpen("changes")}
        >
          <SemanticIcon concept="changes" size="small" />
        </button>
        <button
          type="button"
          data-icon-interaction="standalone"
          class="ui-context-card-rail-item"
          aria-label={t("sessionScreen.environment.openFiles")}
          onClick={() => props.onOpen("files")}
        >
          <SemanticIcon concept="files" size="small" />
        </button>
      </div>
    </aside>
  )
}
