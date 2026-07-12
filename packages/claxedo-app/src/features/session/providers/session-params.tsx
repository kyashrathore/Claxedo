/**
 * Session Params Context
 *
 * Provides session parameters (sessionId, directory, paneId) to components
 * that need to render a session without relying on URL routing.
 *
 * In split mode, each group panel provides its own SessionParamsContext,
 * allowing multiple sessions to render simultaneously.
 *
 * Session-rendering components require this context so route-to-pane handoff is
 * the only owner of URL identity.
 */

import { createSimpleContext } from "@opencode-ai/ui/context"
import type { Accessor } from "solid-js"

const sessionParamsContextInput = {
  name: "SessionParams", gate: true,
  init: (props: {
    sessionId: Accessor<string | undefined>
    directory: Accessor<string>
    paneId: Accessor<string>
    surfaceId?: Accessor<string | undefined>
    leafId?: Accessor<string | undefined>
    active?: Accessor<boolean>
  }) => ({
    sessionId: props.sessionId,
    directory: props.directory,
    paneId: props.paneId,
    surfaceId: props.surfaceId ?? (() => undefined),
    leafId: props.leafId ?? (() => undefined),
    active: props.active ?? (() => true),
  }),
}
const sessionParamsContext = createSimpleContext<ReturnType<typeof sessionParamsContextInput.init>, {
    sessionId: Accessor<string | undefined>
    directory: Accessor<string>
    paneId: Accessor<string>
    surfaceId?: Accessor<string | undefined>
    leafId?: Accessor<string | undefined>
    active?: Accessor<boolean>
  }>(sessionParamsContextInput)

export function useSessionParams() {
  return sessionParamsContext.use()
}

export const SessionParamsProvider = sessionParamsContext.provider
