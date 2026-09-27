import { readCentralOutline } from "./central-session"
import { responseError } from "./errors"
import { onRuntime, sessionEndpoint, type SessionContext } from "./session-context"
import type { SessionOutline, SessionRef } from "./types"
import { outlineFromWire } from "./wire/outline"

export async function readOutline(context: SessionContext, ref: SessionRef): Promise<SessionOutline | undefined> {
  const home = await context.workspaces.home(ref)
  if (home.central) return readCentralOutline(context, home.route.workspaceId, ref)
  if (!home.live) return undefined
  return onRuntime(
    context,
    ref,
    async (where) => {
      const response = await context.transport.runtime(where, sessionEndpoint(ref, "/outline"))
      if (!response.ok) throw await responseError(response, "Turn outline")
      return outlineFromWire(await response.json())
    },
    async () => undefined,
  )
}
