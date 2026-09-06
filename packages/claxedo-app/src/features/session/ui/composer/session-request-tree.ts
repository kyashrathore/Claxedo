import type {
  AgentPermission as PermissionRequest,
  AgentPresentationSession as Session,
  AgentQuestion as QuestionRequest,
} from "@claxedo/agent-runtime-contract"

function sessionTreeRequest<T>(
  session: Session[],
  request: Record<string, T[] | undefined>,
  sessionID?: string,
  include: (item: T) => boolean = () => true,
) {
  if (!sessionID) return undefined

  const map = session.reduce((acc, item) => {
    if (!item.parentID) return acc
    const list = acc.get(item.parentID)
    if (list) list.push(item.id)
    if (!list) acc.set(item.parentID, [item.id])
    return acc
  }, new Map<string, string[]>())

  const seen = new Set([sessionID])
  const ids = [sessionID]
  for (const id of ids) {
    const list = map.get(id)
    if (!list) continue
    for (const child of list) {
      if (seen.has(child)) continue
      seen.add(child)
      ids.push(child)
    }
  }

  const id = ids.find((id) => request[id]?.some(include))
  if (!id) return undefined
  return request[id]?.find(include)
}

export function sessionPermissionRequest(
  session: Session[],
  request: Record<string, PermissionRequest[] | undefined>,
  sessionID?: string,
  include?: (item: PermissionRequest) => boolean,
) {
  return sessionTreeRequest(session, request, sessionID, include)
}

export function sessionVisiblePermissionRequest(input: {
  ready: boolean
  sessions: Session[]
  requests: Record<string, PermissionRequest[] | undefined>
  sessionID?: string
  include?: (item: PermissionRequest) => boolean
}) {
  // Until persisted permission policy has hydrated, the client cannot know
  // whether this request is manual or will be answered by Auto. Rendering it
  // in that gap makes the dock flash and then disappear without a user choice.
  if (!input.ready) return undefined
  return sessionPermissionRequest(
    input.sessions,
    input.requests,
    input.sessionID,
    input.include,
  )
}

export function sessionQuestionRequest(
  session: Session[],
  request: Record<string, QuestionRequest[] | undefined>,
  sessionID?: string,
  include?: (item: QuestionRequest) => boolean,
) {
  return sessionTreeRequest(session, request, sessionID, include)
}
