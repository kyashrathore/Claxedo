import type { HostedAccount } from "./account"
import { isSessionMissing } from "./errors"
import type { Transport, RuntimeRoute } from "./transport"
import type { StatusOwner } from "./status"
import type { SessionLocation } from "./types"
import { isRuntimeUnavailable } from "./wire/connection"
import type { Workspaces } from "./workspaces"

export type SessionContext = {
  readonly transport: Transport
  readonly workspaces: Workspaces
  readonly status: StatusOwner
  readonly account?: HostedAccount
}

export function sessionEndpoint(ref: Pick<SessionLocation, "sessionId">, suffix = "") {
  return `/session/${encodeURIComponent(ref.sessionId)}${suffix}`
}

export async function onRuntime<T>(
  context: SessionContext,
  ref: SessionLocation,
  live: (route: RuntimeRoute) => Promise<T>,
  stopped: (workspaceId: string) => Promise<T>,
): Promise<T> {
  const home = await context.workspaces.home(ref)
  if (!home.live) return stopped(home.route.workspaceId)
  try {
    return await live(home.route)
  } catch (error) {
    if (!isRuntimeUnavailable(error)) throw error
    await context.workspaces.refresh()
    if ((await context.workspaces.home(ref)).live) throw error
    return stopped(home.route.workspaceId)
  }
}

export async function onHistory<T>(
  context: SessionContext,
  ref: SessionLocation,
  live: (route: RuntimeRoute) => Promise<T>,
  stored: (workspaceId: string) => Promise<T>,
  offline: (workspaceId: string) => Promise<T>,
): Promise<T> {
  const home = await context.workspaces.home(ref)
  if (!home.central) return onRuntime(context, ref, live, offline)
  if (!home.live) return stored(home.route.workspaceId)
  return live(home.route).catch((error: unknown) =>
    isSessionMissing(error) || isRuntimeUnavailable(error) ? stored(home.route.workspaceId) : Promise.reject(error))
}
