import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { Composer, ComposerNoticeProvider, ComposerNoticeRow, createComposerNoticeChannel, draftComposerKey, useComposerStore, type Draft, type Submission } from "@/composer"
import { createDraftPlacementResolver, NewSessionContextRow } from "@/projects"
import { useServer, type PlacementId, type ProjectId, type PromptInput } from "@/server"
import { useSessionStores, type SentPrompt, type SessionView } from "@/session"
import type { PaneProps } from "@/shell"
import { ClaxedoLogo } from "@/ui"
import { useWorkbench } from "@/workbench"
import { pendingMessage } from "../transcript/send"
import { draftSessionPaneKind, newDraft } from "./draft-pane"
import { DraftTranscript } from "./draft-transcript"
import { createFirstSend, type FirstSendAttempt } from "./first-send"
import { FirstSendNotice } from "./first-send-notice"
import { PlacementNotice } from "./placement-notice"
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
  const stores = useSessionStores()
  const composers = useComposerStore()
  const server = useServer()
  const workbench = useWorkbench()
  const key = () => draftComposerKey(props.state.draftId)
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
  const firstSend = createFirstSend()
  const attempt = (submission: Submission, prompt: SentPrompt): FirstSendAttempt<SessionView> => async (report) => {
    const placementId = await draft.resolve(props.state, (choice) => report({ type: "createStarted", choice }))
    report({ type: "placementResolved", placementId })
    const ref = await stores.list.create({ placementId, harness: submission.harness, model: submission.model, prompt })
    const view = stores.open(ref)
    view.showSent(prompt)
    return view
  }
  const thinking = () => {
    const state = firstSend.state()
    return state.kind === "sending" && server.cloud.runtime(state.placementId).kind === "live"
  }
  const startSession = (submission: Submission, input: PromptInput, taken: Draft): Promise<SessionView> => {
    const prompt = { ...input, messageId: server.sessions.newMessageId(), sentAt: Date.now() }
    setSent(prompt)
    return firstSend.run(attempt(submission, prompt), { failed: () => composers.restore(key(), taken), retried: () => void composers.take(key()) })
  }
  return (
    <section data-component="session-screen" data-variant="draft" aria-label={t("sessionScreen.draft.title")}>
      <ComposerNoticeProvider channel={notice}>
        <div ref={pane} class="relative flex size-full flex-col overflow-hidden bg-background-base">
          <Show when={sentMessage()} fallback={<div aria-hidden="true" class="h-[34%] shrink-0" />}>
            {(message) => (
              <DraftTranscript message={message()} placementId={props.state.placementId} thinking={thinking()} />
            )}
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
              <Show when={sent()} fallback={<PlacementNotice placementId={props.state.placementId} />}>
                <FirstSendNotice state={firstSend.state()} onRetry={firstSend.retry} />
              </Show>
              <ComposerNoticeRow notices={notice.notices()} />
              <div hidden={!!sent()} class="relative" classList={{ "z-10 -mt-2": notice.notices().length > 0 }}>
                <NewSessionContextRow
                  projectId={props.state.projectId}
                  placementId={props.state.placementId}
                  resolver={draft}
                  onOpen={(target) => workbench.replacePane(props.paneId, draftSessionPaneKind, newDraft(target))}
                />
              </div>
              <div class="relative z-10" classList={{ "-mt-2": !sent() || notice.notices().length > 0 }}>
                <div hidden={firstSend.state().kind === "failed"}>
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
