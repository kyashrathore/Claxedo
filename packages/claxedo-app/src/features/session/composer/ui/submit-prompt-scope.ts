import type { PromptSubmitInput } from "./submit-input"

// `promptScopeKey` lives next to `sessionViewKey` (the neutral shell/identity
// layer) so BOTH the context layer (`context/prompt.tsx`) and this component
// layer share the one canonical derivation without a cross-layer import cycle.
export { promptScopeKey } from "@/platform/identity/session-view-key"

export function uniquePromptScopes(scopes: Array<{ dir: string; id?: string; draftId?: string } | undefined>) {
  return scopes.filter(
    (item, index, arr): item is { dir: string; id?: string; draftId?: string } =>
      !!item && arr.findIndex(
        (other) => other?.dir === item.dir && other?.id === item.id && other?.draftId === item.draftId,
      ) === index,
  )
}

// A prompt scope carries the RAW directory, session id, and draft id. The
// reset/read path applies `promptScopeKey`/`sessionViewKey` exactly once — this
// producer must NOT pre-compute the key or it double-wraps and drifts off the
// composer's read.
export function promptViewScope(input: { directory?: string; sessionId?: string; draftId?: string }) {
  return {
    dir: input.directory ?? "",
    id: input.sessionId,
    ...(input.draftId ? { draftId: input.draftId } : {}),
  }
}

/** Capture the mounted draft identity before any asynchronous provisioning. */
export function capturePromptSubmitScope(
  input: Pick<PromptSubmitInput, "sessionDirectory" | "sessionID" | "draftId" | "conversationDirectory">,
  sdkDirectory: string,
) {
  const projectDirectory = input.sessionDirectory?.()
  const explicitSessionID = input.sessionID?.()
  const draftId = input.draftId?.()
  return {
    projectDirectory,
    explicitSessionID,
    draftId,
    mountedConversationDirectory: input.conversationDirectory?.() ?? sdkDirectory,
    fallbackDirectory: draftId ? undefined : sdkDirectory,
  }
}
