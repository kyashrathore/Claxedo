import { isPluginId } from "@claxedo/plugin-api/id"
import { bodyField, defineOperation, operationPath, requiredParameter, selectBody } from "./operation-definition"
import { operationInput } from "./operation-input"
import { array, object, optional } from "./hosted-output"

const APP_PLUGINS = "/api/claxedo/app-plugins"
const pluginPath = (suffix: string) => operationPath(`${APP_PLUGINS}/:pluginId${suffix}`, { accepts: { pluginId: isPluginId } })
const noContent = optional(object)

function pluginChange(method: "POST" | "DELETE", suffix: string) {
  return defineOperation({
    method, path: pluginPath(suffix),
    input: operationInput({ pluginId: requiredParameter }),
    output: noContent, retry: "never",
    exposure: { renderer: true, app: false },
  })
}

/**
 * The organization's app plugins (`/api/claxedo/app-plugins`), for a signed
 * desktop, whose renderer reaches the control plane only through main. The
 * signed web app sends the same requests to its own origin.
 */
export const APP_PLUGIN_OPERATIONS = {
  "appPlugins.list": defineOperation({
    method: "GET", path: operationPath(APP_PLUGINS),
    input: operationInput({}),
    output: array, retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "appPlugins.installed": defineOperation({
    method: "GET", path: operationPath(`${APP_PLUGINS}/installed`),
    input: operationInput({}),
    output: array, retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "appPlugins.catalog": defineOperation({
    method: "GET", path: operationPath(`${APP_PLUGINS}/catalog`),
    input: operationInput({}),
    output: object, retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "appPlugins.bundle": defineOperation({
    method: "GET", path: pluginPath("/bundles/:sha256/app.js"),
    input: operationInput({ pluginId: requiredParameter, sha256: requiredParameter }),
    output: object, retry: "safe",
    exposure: { renderer: true, app: false },
    response: "bytes",
  }),
  "appPlugins.install": defineOperation({
    method: "POST", path: operationPath(APP_PLUGINS),
    input: operationInput({ id: bodyField, version: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("id", "version"),
  }),
  "appPlugins.update": defineOperation({
    method: "POST", path: pluginPath("/update"),
    input: operationInput({ pluginId: requiredParameter, version: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("version"),
  }),
  "appPlugins.enable": pluginChange("POST", "/enable"),
  "appPlugins.disable": pluginChange("DELETE", "/enable"),
  "appPlugins.organization.disable": pluginChange("POST", "/disable"),
  "appPlugins.organization.enable": pluginChange("DELETE", "/disable"),
  "appPlugins.organization.defaultOn": pluginChange("POST", "/default"),
  "appPlugins.organization.defaultOff": pluginChange("DELETE", "/default"),
  "appPlugins.uninstall": pluginChange("DELETE", ""),
}
