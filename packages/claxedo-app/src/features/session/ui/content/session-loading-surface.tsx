import type { ContentMeta } from "@/features/session/app-ports"

type SessionLoadingSurfaceProps = {
  meta: ContentMeta
  sessionId?: string
  directory?: string
}

/**
 * The page root a session surface presents before `SessionPage` exists.
 *
 * It is the same element the real page renders — same `data-testid`, same
 * readiness attributes, all reporting NOT ready — so a surface that is still
 * assembling is visible to readiness queries as exactly that, rather than as a
 * missing root that cannot be told apart from a surface that never opened.
 *
 * Two callers share it, which is why it is a component rather than markup
 * inside one of them:
 *  - `SessionLoadingSurface` below, the pane-level fallback for a surface whose
 *    identity or connection is not resolved yet;
 *  - `SessionContent`'s mount gate, which holds `SessionPage` for the frames
 *    that belong to the activating click (see `session-mount-settle.ts`).
 */
export function SessionLoadingRoot(props: {
  // The identity fields of the content this surface stands in for, typed from
  // that content rather than re-declared: what it stamps IS the metadata the
  // real page will stamp, and the two must not be able to drift apart.
  sessionId: NonNullable<ContentMeta["sessionId"]> | ""
  directory: NonNullable<ContentMeta["directory"]> | ""
  title?: string
}) {
  return (
    <div
      class="flex size-full flex-col bg-background-base"
      data-testid="session-page-root"
      data-session-id={props.sessionId}
      data-session-directory={props.directory}
      data-session-first-fold-ready="false"
      data-session-messages-ready="false"
      data-session-message-count="0"
      data-session-conversation-count="0"
      data-session-visible-user-count="0"
      data-session-rendered-user-count="0"
      data-session-info-title={props.title ?? ""}
    />
  )
}

export function SessionLoadingSurface(props: SessionLoadingSurfaceProps) {
  const sessionId = () => props.sessionId ?? props.meta.sessionId ?? ""
  const directory = () => props.directory ?? props.meta.directory ?? ""
  const title = () => props.meta.content?.title ?? ""

  return (
    <div
      class="size-full"
      data-testid="session-content"
      data-content-id={props.meta.id}
      data-session-id={sessionId()}
      data-session-directory={directory()}
    >
      <SessionLoadingRoot sessionId={sessionId()} directory={directory()} title={title()} />
    </div>
  )
}
