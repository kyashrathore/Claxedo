import type { ContentMeta } from "@/features/session/app-ports"

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
        <div class="flex size-full items-center justify-center px-6 text-text-weak">
          <div class="flex items-center gap-2">
            <div class="size-4 shrink-0 animate-spin rounded-full border border-border-base border-t-transparent" />
            <div class="text-13-regular text-text-weak">Loading session</div>
          </div>
        </div>
      </div>
    </div>
  )
}
