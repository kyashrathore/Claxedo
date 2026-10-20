import { documentsCliCommand } from "@claxedo/documents/cli"
import type { CliCommand, CliCommandContext } from "@claxedo/plugin-api/cli"
import { requireAccessToken } from "./auth/token-store"
import { config, url } from "./config"
import { requestJson } from "./http"

export const PLUGIN_COMMANDS: readonly CliCommand[] = [documentsCliCommand]

export function pluginCommand(name: string): CliCommand | undefined {
  return PLUGIN_COMMANDS.find((command) => command.name === name)
}

export function cliCommandContext(): CliCommandContext {
  return {
    controlPlaneUrl: () => config().controlPlaneUrl,
    url,
    requestJson,
    requireAccessToken,
    env: process.env,
  }
}
