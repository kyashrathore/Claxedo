import { isRecord } from "@claxedo/helpers/guards"
import type { QueryClient } from "@tanstack/solid-query"
import type { HostedAccount } from "./account"
import type { AppPluginCatalog, AppPluginInstall, AppPluginsApi, EnabledAppPlugin } from "./app-plugin-types"
import { contractMismatch, responseError, ServerError, toAppError } from "./errors"
import { fetchQuery } from "./fetch-query"
import { queryKeys } from "./query-keys"
import type { Transport } from "./transport"
import type { FetchQuery } from "./types"
import { appPluginCatalogFromWire, appPluginInstallsFromWire, enabledAppPluginsFromWire } from "./wire/app-plugins"

const PLUGIN_BACKEND_PATH = "/api/plugins"
const APP_PLUGINS_PATH = "/api/claxedo/app-plugins"

export type AppPluginQueries = {
  readonly offered: boolean
  readonly enabled: () => FetchQuery<readonly EnabledAppPlugin[]>
  readonly installed: () => FetchQuery<readonly AppPluginInstall[]>
  readonly catalog: () => FetchQuery<AppPluginCatalog>
}

function signedAccount(account: HostedAccount | undefined): HostedAccount {
  if (!account) throw new ServerError({ class: "auth", message: "App plugins need a signed account" })
  return account
}

export function appPluginQueries(server: string, account: HostedAccount | undefined): AppPluginQueries {
  return {
    offered: account !== undefined,
    enabled: () => fetchQuery(queryKeys.appPluginsEnabled(server), async () => enabledAppPluginsFromWire(await signedAccount(account).run("appPlugins.list"))),
    installed: () => fetchQuery(queryKeys.appPluginsInstalled(server), async () => appPluginInstallsFromWire(await signedAccount(account).run("appPlugins.installed"))),
    catalog: () => fetchQuery(queryKeys.appPluginsCatalog(server), async () => appPluginCatalogFromWire(await signedAccount(account).run("appPlugins.catalog"))),
  }
}

function decodedBytes(answer: unknown): Uint8Array<ArrayBuffer> {
  if (!isRecord(answer) || typeof answer.bytesBase64 !== "string") throw contractMismatch("app plugin bundle")
  return Uint8Array.from(atob(answer.bytesBase64), (character) => character.charCodeAt(0))
}

async function fetchedBytes(transport: Transport, path: string): Promise<Uint8Array<ArrayBuffer>> {
  const response = await transport.request(path, { headers: { Accept: "text/javascript" } })
  if (!response.ok) throw await responseError(response, "The app plugin bundle")
  try {
    return new Uint8Array(await response.arrayBuffer())
  } catch (error) {
    throw toAppError(error)
  }
}

const OBJECT_BODY_ONLY = "A plugin backend request from the desktop carries a JSON object body or none"

function jsonObjectBody(body: RequestInit["body"]): Record<string, unknown> | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body !== "string") throw new ServerError({ class: "invalid", message: OBJECT_BODY_ONLY })
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    throw new ServerError({ class: "invalid", message: OBJECT_BODY_ONLY, cause: error })
  }
  if (isRecord(parsed)) return parsed
  throw new ServerError({ class: "invalid", message: OBJECT_BODY_ONLY })
}

async function viaAccountBridge(port: HostedAccount, pluginId: string, path: string, init: RequestInit | undefined): Promise<Response> {
  const body = jsonObjectBody(init?.body)
  const answer = await port.run("plugin.request", { pluginId, method: init?.method ?? "GET", path, ...(body ? { body } : {}) })
  if (!isRecord(answer) || typeof answer.status !== "number") throw contractMismatch("plugin backend")
  const nullBody = answer.body === undefined || answer.status === 204 || answer.status === 304
  return new Response(nullBody ? null : JSON.stringify(answer.body), { status: answer.status, headers: nullBody ? {} : { "content-type": "application/json" } })
}

export function createAppPluginsApi(input: {
  readonly transport: Transport
  readonly queryClient: QueryClient
  readonly account: HostedAccount | undefined
  readonly port: HostedAccount | undefined
}): AppPluginsApi | undefined {
  const { transport, queryClient, port } = input
  const account = input.account
  if (!account) return undefined
  const changed = () => queryClient.invalidateQueries({ queryKey: queryKeys.appPluginsAll(transport.serverUrl) })
  const write = async (run: () => Promise<unknown>) => {
    await run()
    await changed()
  }
  const plugin = (pluginId: string) => ({ pluginId })
  return {
    bundle: async (pluginId, sha256) =>
      port
        ? decodedBytes(await port.run("appPlugins.bundle", { pluginId, sha256 }))
        : fetchedBytes(transport, `${APP_PLUGINS_PATH}/${encodeURIComponent(pluginId)}/bundles/${encodeURIComponent(sha256)}/app.js`),
    backendFetch: (pluginId, path, init) =>
      port ? viaAccountBridge(port, pluginId, path, init) : transport.request(`${PLUGIN_BACKEND_PATH}/${encodeURIComponent(pluginId)}${path}`, init),
    install: (pluginId, version) => write(() => account.run("appPlugins.install", { id: pluginId, version })),
    update: (pluginId, version) => write(() => account.run("appPlugins.update", { pluginId, version })),
    setEnabled: (pluginId, enabled) => write(() => account.run(enabled ? "appPlugins.enable" : "appPlugins.disable", plugin(pluginId))),
    setActiveForOrganization: (pluginId, active) =>
      write(() => account.run(active ? "appPlugins.organization.enable" : "appPlugins.organization.disable", plugin(pluginId))),
    setOrganizationDefault: (pluginId, enabled) =>
      write(() => account.run(enabled ? "appPlugins.organization.defaultOn" : "appPlugins.organization.defaultOff", plugin(pluginId))),
    uninstall: (pluginId) => write(() => account.run("appPlugins.uninstall", plugin(pluginId))),
  }
}
