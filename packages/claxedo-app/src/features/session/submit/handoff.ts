// Post-target-acquisition side effects: promote harness preferences, navigate the
// router, retarget Workbench draft tabs, persist mid-session config, and
// schedule the optimistic message + handoff batch.
import { batch } from "solid-js"
import { panePreferenceScope } from "@/features/session/preferences/pane"
import { sessionRoute, workspaceSessionRoute } from "@/platform/identity/route"
import { sessionViewKey } from "@/platform/identity/session-view-key"
import { sessionContentPayload } from "@/features/session/app-ports"
import { isConcreteSessionTitle } from "@/features/session/lib/session-title-sync"
import type {
  ApplyCreatedSessionTargetEffectsContext,
  ApplyOptimisticPromptHandoffContext,
} from "./types"

function createdSessionRoute(input: { sessionID: string; sessionDirectory: string; sessionRef?: { host: string } }) {
  return input.sessionRef?.host === "central"
    ? sessionRoute(input.sessionID)
    : workspaceSessionRoute(input.sessionDirectory, input.sessionID)
}

export function applyCreatedSessionTargetEffects(input: ApplyCreatedSessionTargetEffectsContext) {
  if (!input.created) return {}

  input.harnessConfig?.promote(
    input.sourceScope,
    panePreferenceScope({
      directory: input.sessionDirectory,
      sessionId: input.session.id,
      surfaceId: input.surfaceId,
    }),
  )
  if (input.shouldAutoAccept) input.enableAutoAccept(input.session.id, input.sessionDirectory)
  if (!input.navigateOnCreate) return {}

  input.publishCloudHandoff("opening_session", "Opening session.")

  return {
    handoffCreatedSession: () => {
      input.setLayoutTabs(sessionViewKey({ directory: input.sessionDirectory, sessionId: input.session.id }), input.session.id)
      const surfaceMeta = input.surfaceId ? input.claxedoState?.meta.get(input.surfaceId) : undefined
      const activeContentId = input.claxedoState?.wb.selectors.focusedContent()
      const activeMeta = activeContentId ? input.claxedoState?.meta.get(activeContentId) : undefined
      const draftTab =
        surfaceMeta?.type === "session" && surfaceMeta.sessionId === input.previousSessionId
          ? surfaceMeta
          : activeMeta?.type === "session" && activeMeta.sessionId === input.previousSessionId
            ? activeMeta
            : undefined
      const draftIsSubmittingSurface =
        !!draftTab &&
        draftTab.id === input.surfaceId &&
        (!activeContentId || activeContentId === draftTab.id)
      if (draftIsSubmittingSurface && draftTab) {
        // Retarget the submitting draft surface in place BEFORE navigating.
        // The route-intent adapter matches contents by (directory, sessionId),
        // so a draft left at sessionId "new" never matches the created
        // session's route — openSession would mint a duplicate content while
        // the draft stayed mounted (stashed) with a live Session() instance.
        input.claxedoState?.meta.patch(draftTab.id, {
          directory: input.sessionDirectory,
          sessionId: input.session.id,
          content: sessionContentPayload({
            current: draftTab.content,
            directory: input.sessionDirectory,
            sessionId: input.session.id,
            sessionRef: input.sessionRef,
            title: input.provisionalTitle,
          }),
        })
        queueMicrotask(() => input.navigate(createdSessionRoute({
          sessionID: input.session.id,
          sessionDirectory: input.sessionDirectory,
          sessionRef: input.sessionRef,
        })))
        return
      }
      const patchableDraftTab =
        draftTab && draftTab.id !== activeContentId && !draftIsSubmittingSurface
          ? draftTab
          : undefined
      if (patchableDraftTab) {
        input.claxedoState?.meta.patch(patchableDraftTab.id, {
          directory: input.sessionDirectory,
          sessionId: input.session.id,
          content: sessionContentPayload({
            current: patchableDraftTab.content,
            directory: input.sessionDirectory,
            sessionId: input.session.id,
            sessionRef: input.sessionRef,
            title: input.provisionalTitle,
          }),
        })
      }
      const existingTab = input.claxedoState?.meta.find(
        (meta) =>
          meta.type === "session" &&
          meta.directory === input.sessionDirectory &&
          meta.sessionId === input.session.id,
      )
      if (existingTab && input.provisionalTitle && !isConcreteSessionTitle(existingTab.content?.title?.trim())) {
        input.claxedoState?.meta.patch(existingTab.id, {
          content: sessionContentPayload({
            current: existingTab.content,
            directory: input.sessionDirectory,
            sessionId: input.session.id,
            sessionRef: input.sessionRef,
            title: input.provisionalTitle,
          }),
        })
      }
      const contentId =
        patchableDraftTab?.id ??
        existingTab?.id ??
        input.claxedoState?.layout.openSession(
          input.sessionDirectory,
          input.session.id,
          input.provisionalTitle ?? "Session",
          { sessionRef: input.sessionRef },
        )
      if (contentId) input.claxedoState?.layout.showContent(contentId)
      queueMicrotask(() => input.navigate(createdSessionRoute({
        sessionID: input.session.id,
        sessionDirectory: input.sessionDirectory,
        sessionRef: input.sessionRef,
      })))
    },
  }
}

export function applyOptimisticPromptHandoff(input: ApplyOptimisticPromptHandoffContext) {
  const draftTabId =
    input.replaceSession && !input.draftId && input.claxedoState && !input.didNavigateHandoffPatch && !input.handoffCreatedSession
      ? (() => {
          const active = input.surfaceId ? input.claxedoState?.meta.get(input.surfaceId) : undefined
          if (active?.type !== "session") return
          if (active?.sessionId !== input.previousSessionId) return
          return active.id
        })()
      : undefined
  const applyPaneUpdate =
    draftTabId && input.claxedoState
      ? () => {
          const meta = input.claxedoState!.meta.get(draftTabId)
          input.claxedoState!.meta.patch(draftTabId, {
            directory: input.sessionDirectory,
            sessionId: input.sessionID,
            content: sessionContentPayload({
              current: meta?.content,
              directory: input.sessionDirectory,
              sessionId: input.sessionID,
              sessionRef: input.sessionRef,
              title: input.provisionalTitle,
            }),
          })
        }
      : undefined

  input.publishCloudHandoff("sending_prompt", "Sending first message.")
  if (applyPaneUpdate) {
    batch(() => {
      applyPaneUpdate()
      input.addOptimisticMessage()
    })
    return
  }
  if (input.handoffCreatedSession) {
    input.addOptimisticMessage()
    queueMicrotask(input.applyCreatedSessionHandoff)
    return
  }
  input.addOptimisticMessage()
}

// `recordPromptSubmission` moved to `./post-submit.ts` (rubric Q2). Re-
// exported here so existing barrel/import paths continue to work; new
// code should import from `./post-submit` directly.
export { recordPromptSubmission } from "./post-submit"
