import os from "node:os"
import path from "node:path"
import { trimToUndefined } from "@claxedo/helpers/string"

export type CliConfig = {
  controlPlaneUrl: string
  appUrl: string
  stateDir: string
}

function normalizedUrl(input: string) {
  return input.replace(/\/+$/, "")
}

export function config(env: NodeJS.ProcessEnv = process.env): CliConfig {
  const controlPlaneUrl = normalizedUrl(
    trimToUndefined(env.CLAXEDO_CONTROL_PLANE_URL) ?? trimToUndefined(env.CLAXEDO_API_URL) ?? "https://app.claxedo.com",
  )
  return {
    controlPlaneUrl,
    appUrl: normalizedUrl(trimToUndefined(env.CLAXEDO_APP_URL) ?? "https://app.claxedo.com"),
    stateDir: trimToUndefined(env.CLAXEDO_HOME) ?? path.join(os.homedir(), ".claxedo"),
  }
}

export function url(base: string, pathname: string) {
  return new URL(pathname.replace(/^\/+/, ""), `${base.replace(/\/+$/, "")}/`).toString()
}
