import { Composer, draftComposerKey, useComposerStore } from "@/composer"
import type { PlacementId, ProjectId } from "@/server"
import { useServer } from "@/server"
import { useSessionStores, type SessionView } from "@/session"
import type { PaneProps } from "@/shell"
import { useWorkbench } from "@/workbench"
import { sessionPaneKind } from "./session-pane"
import { useSessionScreenText } from "./text"
import "./session-screen.css"

export type DraftSessionState = {
  readonly projectId: ProjectId
  readonly placementId: PlacementId
  readonly draftId: string
}

export function DraftSessionScreen(props: PaneProps<DraftSessionState>) {
  const t = useSessionScreenText()
  const server = useServer()
  const stores = useSessionStores()
  const composers = useComposerStore()
  const workbench = useWorkbench()
  const key = () => draftComposerKey(props.state.placementId, props.state.draftId)
  const placement = () => server.placements.byId(props.state.placementId)
  const createSession = async (): Promise<SessionView> => {
    const selection = composers.selection(key())
    const ref = await stores.list.create({ placementId: props.state.placementId, harness: selection.harness, model: selection.model })
    return stores.open(ref)
  }
  return (
    <section data-component="session-screen" data-variant="draft" aria-label={t("sessionScreen.draft.title")}>
      <div data-slot="session-screen-body">
        <div data-slot="session-screen-draft">
          <h2 data-slot="session-screen-draft-title">{t("sessionScreen.draft.title")}</h2>
          <p data-slot="session-screen-draft-placement">{placement()?.label}</p>
        </div>
        <div data-slot="session-screen-dock">
          <Composer
            composerKey={key()}
            placementId={props.state.placementId}
            attachmentWorkspace={true}
            createSession={createSession}
            afterAccepted={(view) => workbench.replacePane(props.paneId, sessionPaneKind, view.ref)}
          />
        </div>
      </div>
    </section>
  )
}
