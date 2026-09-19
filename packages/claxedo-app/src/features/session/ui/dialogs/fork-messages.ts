/**
 * Pure logic behind the "fork session" dialog: which route param identifies the
 * session to fork, and how the registered conversation snapshot is projected
 * into the forkable-message list the dialog renders.
 *
 * Kept UI-free so the projection (user-message filtering, first-text-part
 * selection, truncation, reverse-chronological order) is testable without a
 * router or SDK, mirroring the logic/UI split used by prompt-input/history.ts.
 */

import { isRelayHostKind, type WorkspaceHostKind } from "@/platform/runtime/placement-wire"

/**
 * Whether forking in this workspace must reserve the new session first.
 *
 * A workspace the attached server does not serve itself is behind a runtime
 * that records every session it serves, and such a runtime answers
 * `POST .../session` with `session_reservation_required` until the fork has
 * been reserved. The workspace is the sdk's, so its `kind` is already a host
 * kind — narrowing it as a control-plane wire word answers `undefined` for
 * every relay-backed workspace and quietly forks unreserved.
 */
export function forkNeedsReservation(workspace: { readonly kind?: WorkspaceHostKind } | undefined) {
  return isRelayHostKind(workspace?.kind)
}

export interface ForkableMessage {
  readonly id: string
  readonly text: string
  readonly time: string
}

export interface ForkMessageSource {
  readonly id: string
  readonly role: string
  readonly time: { readonly created: number }
}

export interface ForkTextPartSource {
  readonly type: string
  readonly text?: string
  readonly synthetic?: boolean
  readonly ignored?: boolean
}

export interface ForkConversationSnapshot {
  readonly messages: readonly ForkMessageSource[]
  readonly parts: Readonly<Record<string, readonly ForkTextPartSource[] | undefined>>
}

/**
 * The session id to fork, resolved from route params. The canonical routes
 * (`/w/:workspaceId/session/:sessionId`, `/s/:sessionId`) expose it as
 * `sessionId`; the legacy directory route (`/:dir/session/:id?`) exposes it as
 * `id`. Reading only `id` leaves the fork list empty on every canonical route.
 */
export function resolveForkSessionId(params: {
  readonly sessionId?: string
  readonly id?: string
}): string | undefined {
  return params.sessionId ?? params.id
}

/**
 * Projects a conversation snapshot into the forkable-message list: one entry per
 * user message that has a non-synthetic, non-ignored text part, truncated to a
 * single 200-char line, newest first.
 */
export function forkableMessages(
  snapshot: ForkConversationSnapshot,
  options: { readonly formatTime: (date: Date) => string },
): ForkableMessage[] {
  const result: ForkableMessage[] = []

  for (const message of snapshot.messages) {
    if (message.role !== "user") continue

    const parts = snapshot.parts[message.id] ?? []
    const textPart = parts.find((part) => part.type === "text" && !part.synthetic && !part.ignored)
    if (!textPart) continue

    result.push({
      id: message.id,
      text: (textPart.text ?? "").replace(/\n/g, " ").slice(0, 200),
      time: options.formatTime(new Date(message.time.created)),
    })
  }

  return result.reverse()
}
