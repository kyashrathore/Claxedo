import { lazy } from "solid-js"

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
