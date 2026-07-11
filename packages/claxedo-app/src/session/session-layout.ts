// Claxedo session rendering is Workbench-canonical: panes provide session identity.
import { createMemo } from "solid-js"
import { useLayout } from "@/context/layout"
import { useSessionParams } from "@claxedo/claxedo-ui/context/session-params"
import { sessionRoute } from "../shell/identity/route"
import { sessionViewKey } from "../shell/identity/session-view-key"

export const useSessionKey = () => {
  const sessionParams = useSessionParams()

  const params = {
    get id() {
      return sessionParams.sessionId()
    },
  }
  const directory = () => sessionParams.directory()

  const sessionKey = createMemo(() => {
    const id = sessionParams.sessionId()
    if (id && !directory()) return sessionViewKey({ sessionId: id })
    return sessionViewKey({
      directory: directory(),
      sessionId: id,
    })
  })
  return { params, directory, sessionHref: sessionRoute, sessionKey }
}

export const useSessionLayout = () => {
  const layout = useLayout()
  const { params, directory, sessionHref, sessionKey } = useSessionKey()
  return {
    params,
    directory,
    sessionHref,
    sessionKey,
    tabs: createMemo(() => layout.tabs(sessionKey)),
    view: createMemo(() => layout.view(sessionKey)),
  }
}
