import type { StartPreparing, StartResponse, TasksResult } from "../contracts"
import type { StartedSession } from "../ports/session-bridge"

type LinkedStart = Extract<StartResponse, { link: unknown }>

/** The link a Start answered with; a Start that answered `preparing` fails the test that expected a session. */
export function linkedStart(response: StartResponse): LinkedStart {
  if ("preparing" in response) throw new Error(`the Start answered preparing for workspace ${response.preparing.workspaceId}`)
  return response
}

/** The session a bridge's Start created; a refusal or a `preparing` answer fails the test that expected one. */
export function startedSession(result: TasksResult<{ session: StartedSession } | { preparing: StartPreparing }>): StartedSession {
  if (!result.ok) throw new Error(`the Start was refused: ${result.error.message}`)
  if ("preparing" in result) throw new Error(`the Start answered preparing for workspace ${result.preparing.workspaceId}`)
  return result.session
}
