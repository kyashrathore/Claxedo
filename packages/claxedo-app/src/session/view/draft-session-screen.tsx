import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { Composer, ComposerNoticeProvider, ComposerNoticeRow, createComposerNoticeChannel, draftComposerKey, useComposerStore, type Draft, type Submission } from "@/composer"
import { createDraftPlacementResolver, NewSessionContextRow } from "@/projects"
import { sessionId, useServer, type PlacementId, type ProjectId, type PromptInput, type ReservationHold, type SessionReservation } from "@/server"
import { useSessionStores, type SentPrompt, type SessionView } from "@/session"
import type { PaneProps } from "@/shell"
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
  readonly where?: PlacementId
  readonly reservation?: SessionReservation
}

export function DraftSessionScreen(props: PaneProps<DraftSessionState>) {
  const t = useSessionScreenText()
  const stores = useSessionStores()
  const composers = useComposerStore()
  const server = useServer()
  const workbench = useWorkbench()
  const key = () => draftComposerKey(props.state.draftId)
  const where = () => {
    const chosen = props.state.where
    return chosen && server.placements.byId(chosen) ? chosen : props.state.placementId
  }
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
  const reservation: ReservationHold = {
    held: () => props.state.reservation,
    hold: (held) => workbench.updatePane(props.paneId, draftSessionPaneKind, { ...props.state, reservation: held }),
  }
  const firstSend = createFirstSend()
  const attempt = (submission: Submission, prompt: SentPrompt): FirstSendAttempt<SessionView> => async (report) => {
    const placementId = await draft.resolve({ projectId: props.state.projectId, placementId: where() }, (choice) => report({ type: "createStarted", choice }))
    report({ type: "placementResolved", placementId })
    const ref = await stores.list.create({ placementId, harness: submission.harness, model: submission.model, prompt, reservation })
    const view = stores.open(ref)
    view.showSent(prompt)
    return view
  }
  const landed = async () => {
    const held = props.state.reservation
    if (!held) return undefined
    const page = await server.sessions.list({ every: true, sessionId: sessionId(held.sessionId), limit: 1, settled: "all" })
    const row = page.rows[0]
    if (!row) return undefined
    composers.take(key())
    return stores.open(row.ref)
  }
  const thinking = () => {
    const state = firstSend.state()
    return state.kind === "sending" && server.cloud.runtime(state.placementId).kind === "live"
  }
  const startSession = async (submission: Submission, input: PromptInput, taken: Draft): Promise<SessionView | undefined> => {
    const prompt = { ...input, messageId: server.sessions.newMessageId(), sentAt: Date.now() }
    setSent(prompt)
    const view = await firstSend.run(attempt(submission, prompt), { failed: () => composers.restore(key(), taken), retried: () => void composers.take(key()), landed })
    if (!view) setSent(undefined)
    return view
  }
  const placed = (chosen: PlacementId) => workbench.updatePane(props.paneId, draftSessionPaneKind, { ...props.state, where: chosen })
  return (
    <section data-component="session-screen" data-variant="draft" aria-label={t("sessionScreen.draft.title")}>
      <ComposerNoticeProvider channel={notice}>
        <div ref={pane} class="relative flex size-full flex-col overflow-hidden bg-background-base">
          <Show when={sentMessage()} fallback={<div aria-hidden="true" class="h-[calc(34%+4.25rem)] shrink-0" />}>
            {(message) => (
              <DraftTranscript message={message()} placementId={where()} thinking={thinking()} />
            )}
          </Show>
          <div classList={{ "flex shrink-0 justify-center": true, "px-6": !sent(), "pointer-events-none pb-3": !!sent() }}>
            <div
              data-component="session-new-design-content"
              classList={{ "w-full": true, "max-w-[720px]": !sent(), "pointer-events-auto px-3 md:max-w-192 md:mx-auto 2xl:max-w-[880px]": !!sent() }}
            >
              <Show when={sent()} fallback={<PlacementNotice placementId={where()} />}>
                <FirstSendNotice state={firstSend.state()} onRetry={firstSend.retry} onEdit={firstSend.edit} />
              </Show>
              <ComposerNoticeRow notices={notice.notices()} />
              <div hidden={!!sent()} class="relative" classList={{ "z-10 -mt-2": notice.notices().length > 0 }}>
                <NewSessionContextRow
                  projectId={props.state.projectId}
                  placementId={where()}
                  resolver={draft}
                  onPlaced={placed}
                  onOpen={(target) => workbench.replacePane(props.paneId, draftSessionPaneKind, newDraft(target))}
                />
              </div>
              <div class="relative z-10" classList={{ "-mt-2": !sent() || notice.notices().length > 0 }}>
                <div hidden={firstSend.state().kind === "failed"}>
                  <Composer
                    composerKey={key()}
                    placementId={where()}
                    draftDefaultPlacementId={props.state.placementId}
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
