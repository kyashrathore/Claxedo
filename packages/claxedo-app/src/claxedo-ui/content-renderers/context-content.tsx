import { Show } from "solid-js"
import type { ContentMeta } from "../state"
import type { PaneCtx } from "../workbench"
import { SessionPaneScope } from "../components/session-pane-scope"
import { SessionConversationOwner } from "../../shell/chat/session-conversation-owner"
import { SessionContextTab } from "@claxedo/components/session"

export function ContextContent(props: { meta: ContentMeta; ctx: PaneCtx }) {
  const sessionRef = () => props.meta.content?.sessionRef
  return (
    <Show
      when={props.meta.directory}
      fallback={<div class="flex items-center justify-center h-full text-text-weak">Missing workspace</div>}
    >
      {(dir) => (
        <SessionPaneScope
          directory={dir()}
          sessionRef={sessionRef}
          active={props.ctx.isVisible}
          sessionId={() => props.meta.sessionId}
          paneId={() => props.ctx.paneId}
          surfaceId={() => props.meta.id}
          leafId={() => props.meta.id}
        >
          <Show keyed when={props.meta.sessionId}>
            {(sessionId) => (
              <>
                <SessionConversationOwner
                  sessionId={sessionId}
                  messages={() => undefined}
                  parts={() => undefined}
                />
                <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                  <SessionContextTab />
                </div>
              </>
            )}
          </Show>
        </SessionPaneScope>
      )}
    </Show>
  )
}
