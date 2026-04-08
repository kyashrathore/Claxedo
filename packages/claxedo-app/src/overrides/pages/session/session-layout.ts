import { createMemo } from "solid-js"
import { useLayout } from "@/context/layout"
import { useSessionParams } from "@claxedo/claxedo-ui/context/session-params"
import { useClaxedoLayout } from "@claxedo/claxedo-ui/context/claxedo-layout"
import { useGroupId } from "@claxedo/claxedo-ui/context/group-id"
import { base64Encode } from "@opencode-ai/util/encode"

export const useSessionKey = () => {
  let sessionParams: ReturnType<typeof useSessionParams> | undefined
  let claxedoLayout: ReturnType<typeof useClaxedoLayout> | undefined
  let groupId: string | undefined
  try {
    sessionParams = useSessionParams()
  } catch {
    /* not in split mode */
  }
  try {
    claxedoLayout = useClaxedoLayout()
  } catch {
    /* not in claxedo mode */
  }
  try {
    groupId = useGroupId()
  } catch {
    /* not in group scope */
  }

  const fallbackGroup = createMemo(() => {
    if (!claxedoLayout || !groupId) return
    const tab = claxedoLayout.groupTabs(groupId).active()
    if (!tab) return
    return {
      directory: tab.directory,
      sessionId: tab.sessionId,
    }
  })

  const params = {
    get id() {
      return sessionParams?.sessionId() ?? fallbackGroup()?.sessionId
    },
    get dir() {
      if (sessionParams) return base64Encode(sessionParams.directory())
      const dir = fallbackGroup()?.directory
      if (dir) return base64Encode(dir)
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
