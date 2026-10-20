import type { PluginPlatformAnswer } from "@claxedo/plugin-api/backend"
import type { PluginRequestCaller, PluginRunScope, PluginScope } from "./host-port"

export type PluginSupervisorStub = {
  /** Serves a request the host forwards for `caller`, under a caller handle minted for it. Paths under `/_` are refused. */
  request(caller: PluginRequestCaller, request: Request): Promise<Response>
  object(scope: PluginRunScope, className: string, name: string, request: Request): Promise<Response>
  active(scope: PluginRunScope): Promise<boolean>
  /** A platform call the backend loaded under `scope` made, with the caller handle of the request or wake it serves. */
  platform(scope: PluginRunScope, call: unknown, handle: string | undefined): Promise<PluginPlatformAnswer>
  /** Reads the install again, so a run the change ended stops now rather than at the next request. */
  refresh(scope: PluginScope): Promise<void>
  /**
   * Deletes every object the plugin stored, its wakes and its blob accounting,
   * once the host has removed its install. Refused while the host still answers
   * an active backend.
   */
  purge(scope: PluginScope): Promise<void>
  /** Delivers the wakes due at `now`, which the supervisor's alarm does with the current time; answers how many. */
  wakeDue(scope: PluginScope, now: number): Promise<number>
}

export interface PluginSupervisorNamespace {
  idFromName(name: string): unknown
  get(id: unknown): PluginSupervisorStub
}

export function pluginSupervisorName(scope: PluginScope): string {
  return `org:${scope.orgId}:plugin:${scope.pluginId}`
}

/** The one supervisor a plugin's backend runs under in an organization. */
export function pluginSupervisor(namespace: PluginSupervisorNamespace, scope: PluginScope): PluginSupervisorStub {
  return namespace.get(namespace.idFromName(pluginSupervisorName(scope)))
}
