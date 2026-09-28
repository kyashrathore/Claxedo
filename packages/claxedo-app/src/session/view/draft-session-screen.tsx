import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { Composer, ComposerNoticeProvider, ComposerNoticeRow, createComposerNoticeChannel, draftComposerKey, type Submission } from "@/composer"
import { createDraftPlacementResolver, NewSessionContextRow } from "@/projects"
import { useServer, type PlacementId, type ProjectId, type PromptInput } from "@/server"
import { useSessionStores, type SentPrompt, type SessionView } from "@/session"
import type { PaneProps } from "@/shell"
import { ClaxedoLogo } from "@/ui"
import { useWorkbench } from "@/workbench"
import { pendingMessage } from "../transcript/send"
import { draftSessionPaneKind } from "./draft-pane"
import { SentMessage } from "./sent-message"
import { sessionPaneKind } from "./session-pane"
import { useSessionScreenText } from "./text"
import { WorkspaceSleepCard } from "./workspace-sleep"
import "./session-screen.css"

export type DraftSessionState = {
  readonly projectId: ProjectId
  readonly placementId: PlacementId
}

export function DraftSessionScreen(props: PaneProps<DraftSessionState>) {
  const t = useSessionScreenText()
  const stores = useSessionStores()
  const server = useServer()
  const workbench = useWorkbench()
  const key = () => draftComposerKey(props.state.placementId)
  const notice = createComposerNoticeChannel()
  const draft = createDraftPlacementResolver()
  let pane: HTMLDivElement | undefined
  const [sent, setSent] = createSignal<SentPrompt>()
  const sentMessage = createMemo(() => {
    const prompt = sent()
    return prompt && pendingMessage("", prompt)
  })
  const [started, setStarted] = createSignal<SessionView>()
  createEffect(() => {
    const view = started()
    if (view && view.state().kind !== "loading") workbench.replacePane(props.paneId, sessionPaneKind, view.ref)
  })
  const startSession = async (submission: Submission, input: PromptInput): Promise<SessionView> => {
    const prompt = { ...input, messageId: server.sessions.newMessageId(), sentAt: Date.now() }
    setSent(prompt)
    try {
      const ref = await stores.list.create({ placementId: await draft.resolve(props.state), harness: submission.harness, model: submission.model, prompt })
      const view = stores.open(ref)
      view.showSent(prompt)
      return view
    } catch (error) {
      setSent(undefined)
      throw error
    }
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
                    resolver={draft}
                    onOpen={(target) => workbench.replacePane(props.paneId, draftSessionPaneKind, target)}
                  />
                </div>
                <Show when={sentMessage()}>{(message) => <SentMessage message={message()} placementId={props.state.placementId} />}</Show>
                <div class="relative z-10 -mt-2">
                  <WorkspaceSleepCard placementId={props.state.placementId} />
                  <Composer
                    composerKey={key()}
                    placementId={props.state.placementId}
                    attachmentWorkspace={true}
                    startSession={startSession}
                    afterAccepted={setStarted}
                    dropZone={() => pane}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </ComposerNoticeProvider>
    </section>
  )
}
