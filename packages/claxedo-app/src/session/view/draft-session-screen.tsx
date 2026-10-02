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
import { DraftTranscript } from "./draft-transcript"
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
    const placementId = draft.resolve(props.state)
    setSent(prompt)
    try {
      const ref = await stores.list.create({ placementId: await placementId, harness: submission.harness, model: submission.model, prompt })
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
        <div ref={pane} class="relative flex size-full flex-col overflow-hidden bg-background-base">
          <Show when={sentMessage()} fallback={<div aria-hidden="true" class="h-[34%] shrink-0" />}>
            {(message) => <DraftTranscript message={message()} placementId={props.state.placementId} />}
          </Show>
          <div classList={{ "flex shrink-0 justify-center": true, "px-6": !sent(), "pointer-events-none pb-3": !!sent() }}>
            <div
              data-component="session-new-design-content"
              classList={{ "w-full": true, "max-w-[720px]": !sent(), "pointer-events-auto px-3 md:max-w-192 md:mx-auto 2xl:max-w-[880px]": !!sent() }}
            >
              <Show when={!sent()}>
                <div class="mb-5 flex justify-center">
                  <ClaxedoLogo class="w-12 opacity-14" />
                </div>
              </Show>
              <ComposerNoticeRow notice={notice.current()} />
              <Show when={!sent()}>
                <div class="relative" classList={{ "z-10 -mt-2": !!notice.current() }}>
                  <NewSessionContextRow
                    projectId={props.state.projectId}
                    placementId={props.state.placementId}
                    resolver={draft}
                    onOpen={(target) => workbench.replacePane(props.paneId, draftSessionPaneKind, target)}
                  />
                </div>
              </Show>
              <div class="relative z-10" classList={{ "-mt-2": !sent() || !!notice.current() }}>
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
      </ComposerNoticeProvider>
    </section>
  )
}
