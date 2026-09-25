import { Hono } from "hono"
import { z } from "zod"
import { routeParam } from "@claxedo/helpers/route-param"
import { PLUGIN_ID_PATTERN } from "@claxedo/plugin-api"
import { ControlPlaneAuthError, controlPlaneAuthErrorBody, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { errorBody } from "@claxedo/server-core/platform/http/http"
import { controlPlaneRouteAuth, signedRouteAuth, type ControlPlaneRouteAuthOptions } from "../platform/http/control-plane-route-auth"
import { BUNDLE_HASH_PATTERN } from "./bundles"
import { LivePluginAddError, livePluginService, type LivePluginService } from "./service"
import { listPluginSource, PluginSourceError, readPluginSource } from "./source"

const addBody = z.object({ directory: z.string().trim().min(1) }).strict()

export type LivePluginRouteDeps = {
  service?: LivePluginService
  authorizeMachineOwner?: (auth: SignedControlPlaneAuth) => void
}

function requireMachineOwner(request: Request, deps: LivePluginRouteDeps) {
  const auth = signedRouteAuth(request)
  if (!auth) return
  if (!deps.authorizeMachineOwner) {
    throw new ControlPlaneAuthError(403, "operator_required", "Live plugins belong to this machine's owner")
  }
  deps.authorizeMachineOwner(auth)
}

async function registeredDirectory(service: LivePluginService, id: string) {
  if (!PLUGIN_ID_PATTERN.test(id)) {
    return { status: 400 as const, error: errorBody("live_plugin_id_invalid", "A plugin id is lowercase letters, digits and dashes") }
  }
  await service.ready
  const directory = service.directory(id)
  if (directory === undefined) return { status: 404 as const, error: errorBody("live_plugin_not_found", `No plugin ${id} is registered`) }
  return { path: directory }
}

export function LivePluginRoutes(options: ControlPlaneRouteAuthOptions = {}, deps: LivePluginRouteDeps = {}) {
  const service = () => deps.service ?? livePluginService()
  return new Hono()
    .onError((error, c) => {
      if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
      if (error instanceof LivePluginAddError) return c.json(errorBody(error.code, error.message), error.status)
      if (error instanceof PluginSourceError) return c.json(errorBody(error.code, error.message), error.status)
      throw error
    })
    .get("/", controlPlaneRouteAuth(options), async (c) => {
      requireMachineOwner(c.req.raw, deps)
      await service().ready
      return c.json({ plugins: service().list() })
    })
    .post("/", controlPlaneRouteAuth(options), async (c) => {
      requireMachineOwner(c.req.raw, deps)
      const parsed = addBody.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return c.json(errorBody("live_plugin_request_invalid", "Send { directory: <absolute path of the plugin folder> }"), 400)
      await service().ready
      return c.json(await service().add(parsed.data.directory), 201)
    })
    .delete("/:id", controlPlaneRouteAuth(options), async (c) => {
      requireMachineOwner(c.req.raw, deps)
      const id = routeParam(c, "id")
      if (!PLUGIN_ID_PATTERN.test(id)) return c.json(errorBody("live_plugin_id_invalid", "A plugin id is lowercase letters, digits and dashes"), 400)
      await service().ready
      if (!(await service().remove(id))) return c.json(errorBody("live_plugin_not_found", `No plugin ${id} is registered`), 404)
      return c.body(null, 204)
    })
    .get("/:id/source", controlPlaneRouteAuth(options), async (c) => {
      requireMachineOwner(c.req.raw, deps)
      const directory = await registeredDirectory(service(), routeParam(c, "id"))
      if ("error" in directory) return c.json(directory.error, directory.status)
      return c.json(await listPluginSource(directory.path))
    })
    .get("/:id/source/file", controlPlaneRouteAuth(options), async (c) => {
      requireMachineOwner(c.req.raw, deps)
      const directory = await registeredDirectory(service(), routeParam(c, "id"))
      if ("error" in directory) return c.json(directory.error, directory.status)
      return c.json(await readPluginSource(directory.path, c.req.query("path") ?? ""))
    })
    .get("/:id/:hash/app.js", controlPlaneRouteAuth(options), async (c) => {
      requireMachineOwner(c.req.raw, deps)
      const id = routeParam(c, "id")
      const hash = routeParam(c, "hash")
      if (!PLUGIN_ID_PATTERN.test(id) || !BUNDLE_HASH_PATTERN.test(hash)) {
        return c.json(errorBody("live_plugin_bundle_invalid", "A bundle is addressed by plugin id and build hash"), 400)
      }
      await service().ready
      const code = await service().bundle(id, hash)
      if (code === undefined) return c.json(errorBody("live_plugin_bundle_not_found", `No build ${hash} of ${id} is stored`), 404)
      return c.body(code, 200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=31536000, immutable",
      })
    })
}
