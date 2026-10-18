import { EVENT_CURSOR_HEADER } from "@claxedo/agent-runtime-contract"
import type { HostedAccount } from "./account"
import { isSessionMissing, responseError } from "./errors"
import type { SnapshotCoverage, SnapshotDatum } from "./snapshot-coverage"
import type { Transport, RuntimeRoute } from "./transport"
import type { StatusOwner } from "./status"
import type { SessionLocation } from "./types"
import { isRuntimeUnavailable } from "./wire/connection"
import type { SessionHome, Workspaces } from "./workspaces"

export type SessionContext = {
  readonly transport: Transport
  readonly workspaces: Workspaces
  readonly status: StatusOwner
  readonly coverage: SnapshotCoverage
  readonly account?: HostedAccount
}

export async function readSnapshotDatum(context: SessionContext, route: RuntimeRoute, path: string, ref: SessionLocation, datum: SnapshotDatum, what: string): Promise<unknown> {
  const read = context.coverage.reading(ref, datum)
  try {
    const response = await context.transport.runtime(route, path)
    if (!response.ok) throw await responseError(response, what)
    const body: unknown = response.status === 204 ? undefined : await response.json()
    read.landed(response.headers.get(EVENT_CURSOR_HEADER))
    return body
  } catch (error) {
    read.failed()
    throw error
  }
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
  return runtimeAt(context, await context.workspaces.home(ref), ref, live, stopped)
}

export async function runtimeAt<T>(
  context: SessionContext,
  home: SessionHome,
  ref: SessionLocation,
  live: (route: RuntimeRoute) => Promise<T>,
  stopped: (workspaceId: string) => Promise<T>,
): Promise<T> {
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
  return historyAt(context, await context.workspaces.home(ref), ref, live, stored, offline)
}

export async function historyAt<T>(
  context: SessionContext,
  home: SessionHome,
  ref: SessionLocation,
  live: (route: RuntimeRoute) => Promise<T>,
  stored: (workspaceId: string) => Promise<T>,
  offline: (workspaceId: string) => Promise<T>,
): Promise<T> {
  if (!home.central) return runtimeAt(context, home, ref, live, offline)
  if (!home.live) return stored(home.route.workspaceId)
  return live(home.route).catch((error: unknown) =>
    isSessionMissing(error) || isRuntimeUnavailable(error) ? stored(home.route.workspaceId) : Promise.reject(error))
}
