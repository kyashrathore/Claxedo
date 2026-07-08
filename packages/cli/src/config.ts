import os from "node:os"
import path from "node:path"

export type CliConfig = {
  controlPlaneUrl: string
  appUrl: string
  stateDir: string
}

function clean(input: string | undefined) {
  const value = input?.trim()
  return value ? value : undefined
}

function normalizedUrl(input: string) {
  return input.replace(/\/+$/, "")
}

export function config(): CliConfig {
  const controlPlaneUrl = normalizedUrl(
    clean(process.env.CLAXEDO_CONTROL_PLANE_URL) ?? clean(process.env.CLAXEDO_API_URL) ?? "https://app.claxedo.com",
  )
  return {
    controlPlaneUrl,
    appUrl: normalizedUrl(clean(process.env.CLAXEDO_APP_URL) ?? "https://app.claxedo.com"),
    stateDir: clean(process.env.CLAXEDO_HOME) ?? path.join(os.homedir(), ".claxedo"),
  }
}

export function url(base: string, pathname: string) {
  return new URL(pathname.replace(/^\/+/, ""), `${base.replace(/\/+$/, "")}/`).toString()
}
