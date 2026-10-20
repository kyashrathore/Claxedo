import { Hono, type Context } from "hono"
import { isPluginId } from "@claxedo/plugin-api/id"
import { pluginRefusal, SHA256_HEX_PATTERN } from "@claxedo/plugin-runtime"
import { readJsonRecord } from "@claxedo/server-core/platform/json/index"
import { isClaxedoError } from "@claxedo/server-core/platform/errors/base"
import type { ControlPlaneRouteContribution } from "@claxedo/server-core/platform/http/route-contribution"
import type { OrgAdministers } from "../credentials/worker/org-administers"
import { readPluginBundle } from "./bundles"
import {
  AppPluginInstalledError,
  listAppPluginInstalls,
  listEnabledAppPlugins,
  readAppPluginAccess,
  readAppPluginInstall,
  writeAppPluginEnablement,
  writeAppPluginOrgDefault,
  type AppPluginInstall,
} from "./installs"
import { installAppPlugin, setAppPluginActive, uninstallAppPlugin, updateAppPlugin, type AppPluginLifecyclePorts } from "./lifecycle"
import { readPluginLink } from "./links"
import { orgCallerOrRefusal, type OrgCaller, type OrgCallerInput } from "./org-caller"
import { APP_PLUGINS_ROUTE_PREFIX } from "./paths"
import { forwardToPlugin } from "./routes"

export type AppPluginRoutesInput = OrgCallerInput &
  Readonly<{
    lifecycle: AppPluginLifecyclePorts
    administers: OrgAdministers
  }>

/** The bundle a member's app loads; its URL names its content, so a browser may keep it for good. */
const BUNDLE_HEADERS = {
  "content-type": "text/javascript; charset=utf-8",
  "cache-control": "private, max-age=31536000, immutable",
  "x-content-type-options": "nosniff",
}

const REFUSAL_STATUS: Readonly<Record<string, number>> = {
  app_plugin_not_installed: 404,
  app_plugin_installed: 409,
  app_plugin_storage_downgrade: 409,
  app_plugin_platform_unavailable: 409,
  app_plugin_release_invalid: 422,
  app_plugin_release_unavailable: 502,
}

function installBody(install: AppPluginInstall) {
  return { id: install.pluginId, version: install.version, active: install.active, manifest: install.manifest, app: { sha256: install.appSha256 } }
}

function refusedChange(error: unknown): Response {
  if (error instanceof AppPluginInstalledError) return pluginRefusal(409, "app_plugin_installed", error.message)
  if (isClaxedoError(error)) {
    const status = REFUSAL_STATUS[error.code]
    if (status) return pluginRefusal(status, error.code, error.message)
  }
  throw error
}

/**
 * `/api/claxedo/app-plugins`: what an organization has installed and what each
 * member has enabled. Every route acts in the caller's own organization.
 *
 * Members:
 * - `GET /` lists the plugins the caller's app loads: installed, active and enabled for them;
 * - `GET /installed` lists every install with whether it is enabled for the caller;
 * - `GET /:id/bundles/:sha256/app.js` answers an app bundle only while that list holds it with that hash;
 * - `POST /:id/enable` and `DELETE /:id/enable` set the caller's own choice.
 *
 * Anyone: `GET /links/:token` reads the path a plugin's live public link was
 * created for, as a `link` caller, while the plugin is installed and active.
 *
 * Owners and admins:
 * - `POST /` installs `{ id, version }` from the registry;
 * - `POST /:id/update` replaces it with `{ version }`;
 * - `POST /:id/disable` and `DELETE /:id/disable` turn it off and back on for everyone, keeping its storage;
 * - `POST /:id/default` and `DELETE /:id/default` set or clear the organization's positive default;
 * - `DELETE /:id` uninstalls it and deletes everything it stored.
 */
export function appPluginRouteContribution(input: AppPluginRoutesInput): ControlPlaneRouteContribution {
  const { database } = input.lifecycle
  const routes = new Hono()

  const member = (run: (caller: OrgCaller, context: Context) => Promise<Response>) => async (context: Context) => {
    const caller = await orgCallerOrRefusal(context.req.raw, input)
    return caller instanceof Response ? caller : run(caller, context)
  }
  const admin = (run: (caller: OrgCaller, context: Context) => Promise<Response>) =>
    member(async (caller, context) => {
      if (!(await input.administers(caller.auth, caller.orgId))) {
        return pluginRefusal(403, "app_plugin_admin_required", "Only an owner or admin of the organization manages its app plugins")
      }
      return run(caller, context)
    })
  const pluginScope = (caller: OrgCaller, context: Context) => {
    const pluginId = context.req.param("pluginId") ?? ""
    return isPluginId(pluginId) ? { orgId: caller.orgId, pluginId } : undefined
  }
  const unknownPlugin = () => pluginRefusal(404, "app_plugin_not_installed", "No plugin has that id")
  const versionOf = async (context: Context) => {
    const version = (await readJsonRecord(context.req.raw))?.version
    return typeof version === "string" ? version : undefined
  }

  routes.get("/", member(async (caller) => Response.json((await listEnabledAppPlugins(database, caller.orgId, caller.userId)).map(installBody))))

  routes.get("/links/:token", async (context) => {
    const supervisors = input.lifecycle.supervisors
    const target = supervisors ? await readPluginLink(database, context.req.param("token"), input.lifecycle.now()) : undefined
    if (!supervisors || !target) return pluginRefusal(404, "plugin_link_not_found", "No live link has that token")
    return forwardToPlugin(supervisors, { orgId: target.orgId, pluginId: target.pluginId, origin: "link" }, { method: "GET", path: target.path, search: "", body: null })
  })

  routes.get("/installed", member(async (caller) =>
    Response.json((await listAppPluginInstalls(database, caller.orgId, caller.userId)).map((install) => ({
      ...installBody(install),
      enabledForMe: install.enabledForMe,
      orgDefault: install.orgDefault,
    }))),
  ))

  routes.get("/:pluginId/bundles/:sha256/app.js", member(async (caller, context) => {
    const scope = pluginScope(caller, context)
    const sha256 = context.req.param("sha256") ?? ""
    if (!scope || !SHA256_HEX_PATTERN.test(sha256)) return unknownPlugin()
    const [access, install] = await Promise.all([readAppPluginAccess(database, scope, caller.userId), readAppPluginInstall(database, scope)])
    if (access !== "enabled" || install?.appSha256 !== sha256) return pluginRefusal(404, "app_plugin_bundle_not_found", `No enabled plugin ${scope.pluginId} has bundle ${sha256}`)
    const code = await readPluginBundle(input.lifecycle.bucket, "app", sha256)
    if (code === undefined) return pluginRefusal(503, "app_plugin_bundle_unavailable", `The bundle of plugin ${scope.pluginId} is not stored`)
    return new Response(code, { headers: BUNDLE_HEADERS })
  }))

  const enablement = (enabled: boolean) =>
    member(async (caller, context) => {
      const scope = pluginScope(caller, context)
      if (!scope) return unknownPlugin()
      const written = await writeAppPluginEnablement(database, { ...scope, userId: caller.userId, enabled, now: input.lifecycle.now() })
      return written ? new Response(null, { status: 204 }) : unknownPlugin()
    })
  routes.post("/:pluginId/enable", enablement(true))
  routes.delete("/:pluginId/enable", enablement(false))

  routes.post("/", admin(async (caller, context) => {
    const body = await readJsonRecord(context.req.raw)
    const pluginId = typeof body?.id === "string" ? body.id : ""
    const version = typeof body?.version === "string" ? body.version : undefined
    if (!isPluginId(pluginId) || !version) return pluginRefusal(400, "invalid_input", "id and version are required")
    try {
      const install = await installAppPlugin(input.lifecycle, { orgId: caller.orgId, pluginId, version, userId: caller.userId })
      return Response.json(installBody(install), { status: 201 })
    } catch (error) {
      return refusedChange(error)
    }
  }))

  routes.post("/:pluginId/update", admin(async (caller, context) => {
    const scope = pluginScope(caller, context)
    const version = await versionOf(context)
    if (!scope) return unknownPlugin()
    if (!version) return pluginRefusal(400, "invalid_input", "version is required")
    try {
      return Response.json(installBody(await updateAppPlugin(input.lifecycle, { ...scope, version, userId: caller.userId })))
    } catch (error) {
      return refusedChange(error)
    }
  }))

  const orgSwitch = (active: boolean) =>
    admin(async (caller, context) => {
      const scope = pluginScope(caller, context)
      if (!scope) return unknownPlugin()
      try {
        await setAppPluginActive(input.lifecycle, { ...scope, active, userId: caller.userId })
        return new Response(null, { status: 204 })
      } catch (error) {
        return refusedChange(error)
      }
    })
  routes.post("/:pluginId/disable", orgSwitch(false))
  routes.delete("/:pluginId/disable", orgSwitch(true))

  const orgDefault = (enabled: boolean) =>
    admin(async (caller, context) => {
      const scope = pluginScope(caller, context)
      if (!scope) return unknownPlugin()
      return (await writeAppPluginOrgDefault(database, { ...scope, enabled })) ? new Response(null, { status: 204 }) : unknownPlugin()
    })
  routes.post("/:pluginId/default", orgDefault(true))
  routes.delete("/:pluginId/default", orgDefault(false))

  routes.delete("/:pluginId", admin(async (caller, context) => {
    const scope = pluginScope(caller, context)
    if (!scope) return unknownPlugin()
    return (await uninstallAppPlugin(input.lifecycle, scope)) ? new Response(null, { status: 204 }) : unknownPlugin()
  }))

  return { id: "app-plugins", path: APP_PLUGINS_ROUTE_PREFIX, routes }
}
