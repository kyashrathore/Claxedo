import { lazy, Suspense, type ParentProps } from "solid-js"

export const SessionComposerRegion = lazy(() =>
  import("@/features/session/ui/composer/session-composer-region").then((module) => ({
    default: module.SessionComposerRegion,
  })),
)

export const MessageTimeline = lazy(() =>
  import("@/features/session/ui/message-timeline").then((module) => ({
    default: module.MessageTimeline,
  })),
)

export const PromptInput = lazy(() =>
  import("@/features/session/composer/composer").then((module) => ({
    default: module.PromptInput,
  })),
)

export function SessionComposerLoadBoundary(props: ParentProps) {
  return (
    <Suspense fallback={<div aria-hidden="true" class="h-44 shrink-0" data-component="session-prompt-dock-loading" />}>
      {props.children}
    </Suspense>
  )
}
