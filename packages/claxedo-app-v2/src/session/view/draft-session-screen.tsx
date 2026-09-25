import { Composer, ComposerNoticeProvider, ComposerNoticeRow, createComposerNoticeChannel, draftComposerKey, type Submission } from "@/composer"
import { NewSessionContextRow, resolveDraftPlacement } from "@/projects"
import type { PlacementId, ProjectId } from "@/server"
import { useSessionStores, type SessionView } from "@/session"
import { useCommands, useShellRoute, type PaneProps } from "@/shell"
import { ClaxedoLogo } from "@/ui"
import { useWorkbench } from "@/workbench"
import { draftSessionPaneKind } from "./draft-pane"
import { sessionPaneKind } from "./session-pane"
import { useSessionScreenText } from "./text"
import { registerSessionCommands } from "./session-commands"
import { RunningWorkspace } from "./workspace-start"
import "./session-screen.css"

export type DraftSessionState = {
  readonly projectId: ProjectId
  readonly placementId: PlacementId
}

export function DraftSessionScreen(props: PaneProps<DraftSessionState>) {
  const t = useSessionScreenText()
  const stores = useSessionStores()
  const workbench = useWorkbench()
  const routing = useShellRoute()
  registerSessionCommands({ commands: useCommands(), placementId: () => props.state.placementId, active: () => props.active, navigate: (path) => routing.navigate(path), t })
  const key = () => draftComposerKey(props.state.placementId)
  const notice = createComposerNoticeChannel()
  let pane: HTMLDivElement | undefined
  const createSession = async (submission: Submission): Promise<SessionView> => {
    const ref = await stores.list.create({ placementId: await resolveDraftPlacement(props.state), harness: submission.harness, model: submission.model })
    return stores.open(ref)
  }
  return (
    <section data-component="session-screen" data-variant="draft" aria-label={t("sessionScreen.draft.title")}>
      <ComposerNoticeProvider channel={notice}>
        <div ref={pane} class="relative size-full overflow-hidden bg-background-base">
          <div class="absolute inset-x-0 top-[34%] flex justify-center px-6">
            <div data-component="session-new-design-content" class="w-full max-w-[720px]">
              <div class="mb-5 flex justify-center">
                <ClaxedoLogo class="w-12 opacity-14" />
              </div>
              <div>
                <ComposerNoticeRow notice={notice.current()} />
                <div class="relative" classList={{ "z-10 -mt-2": !!notice.current() }}>
                  <NewSessionContextRow
                    projectId={props.state.projectId}
                    placementId={props.state.placementId}
                    onOpen={(target) => workbench.replacePane(props.paneId, draftSessionPaneKind, target)}
                  />
                </div>
                <div class="relative z-10 -mt-2">
                  <RunningWorkspace placementId={props.state.placementId} startOnOpen>
                    <Composer
                      composerKey={key()}
                      placementId={props.state.placementId}
                      attachmentWorkspace={true}
                      createSession={createSession}
                      afterAccepted={(view) => workbench.replacePane(props.paneId, sessionPaneKind, view.ref)}
                      dropZone={() => pane}
                    />
                  </RunningWorkspace>
                </div>
              </div>
            </div>
          </div>
        </div>
      </ComposerNoticeProvider>
    </section>
  )
}
