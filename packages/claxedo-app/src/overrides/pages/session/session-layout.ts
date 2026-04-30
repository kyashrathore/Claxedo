import { createMemo } from "solid-js"
import { useLayout } from "@/context/layout"
import { useSessionParams } from "@claxedo/claxedo-ui/context/session-params"
import { base64Encode } from "@opencode-ai/util/encode"

export const useSessionKey = () => {
  let sessionParams: ReturnType<typeof useSessionParams> | undefined
  try {
    sessionParams = useSessionParams()
  } catch {
    /* not in split mode */
  }

  const params = {
    get id() {
      return sessionParams?.sessionId()
    },
    get dir() {
      if (sessionParams) return base64Encode(sessionParams.directory())
      return undefined
    },
  }

  const sessionKey = createMemo(() => `${params.dir}${params.id ? "/" + params.id : ""}`)
  return { params, sessionKey }
}

export const useSessionLayout = () => {
  const layout = useLayout()
  const { params, sessionKey } = useSessionKey()
  return {
    params,
    sessionKey,
    tabs: createMemo(() => layout.tabs(sessionKey)),
    view: createMemo(() => layout.view(sessionKey)),
  }
}
