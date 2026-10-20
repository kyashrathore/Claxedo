import type { PluginCaller, PluginCallerRecord, PluginRunScope, PluginScope } from "./host-port"

export type PluginSupervisorStub = {
  /** Serves a request the host authenticated for `caller`, under a caller handle minted for it. */
  request(caller: PluginCaller, request: Request): Promise<Response>
  object(scope: PluginRunScope, className: string, name: string, request: Request): Promise<Response>
  active(scope: PluginRunScope): Promise<boolean>
  caller(scope: PluginRunScope, handle: string): Promise<PluginCallerRecord | null>
  /** Reads the install again, so a run the change ended stops now rather than at the next request. */
  refresh(scope: PluginScope): Promise<void>
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
