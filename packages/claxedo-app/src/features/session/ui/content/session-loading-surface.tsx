import type { ContentMeta } from "@/features/session/app-ports"
import { SessionTimelineSkeleton } from "@/features/session/ui/content/session-timeline-skeleton"

type SessionLoadingSurfaceProps = {
  meta: ContentMeta
  sessionId?: string
  directory?: string
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
      <div
        class="flex size-full flex-col bg-background-base"
        data-testid="session-page-root"
        data-session-id={sessionId()}
        data-session-directory={directory()}
        data-session-first-fold-ready="false"
        data-session-messages-ready="false"
        data-session-message-count="0"
        data-session-conversation-count="0"
        data-session-visible-user-count="0"
        data-session-rendered-user-count="0"
        data-session-info-title={title()}
      >
        <SessionTimelineSkeleton />
      </div>
    </div>
  )
}
