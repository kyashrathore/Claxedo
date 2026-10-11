import type { StatusHookTemplate } from "@claxedo/plugin-api"
import { NOTIFY_MARKER } from "./constants"
import type { HookPlatform } from "./platform"
import { batchText, loadTemplate } from "./utils"

export function generateNotifyScript(
  port: number,
  templates: readonly StatusHookTemplate[],
  platform: HookPlatform,
): string {
  const windows = platform === "windows"
  const aliases = templates
    .flatMap((template) =>
      [...(template.command === template.provider ? [] : [template.command]), ...(template.aliases ?? [])].map(
        (alias) =>
          windows
            ? `if "%AGENT%"=="${alias}" set "AGENT=${template.provider}"`
            : `  ${alias}) AGENT="${template.provider}" ;;`,
      ),
    )
    .join("\n")
  const guards = templates
    .flatMap((template) => {
      const guard = template.replayGuard
      if (!guard) return []
      return windows
        ? [`if "%HARNESS%"=="${template.provider}" if defined ${guard.env} exit /b 0`]
        : [`    if [ "$HARNESS" = "${template.provider}" ] && [ -n "$${guard.env}" ]; then exit 0; fi`]
    })
    .join("\n")
  const variables = { MARKER: NOTIFY_MARKER, PORT: String(port), ALIASES: aliases, REPLAY_GUARDS: guards }
  return windows
    ? batchText(loadTemplate("notify.cmd.template.txt", variables))
    : loadTemplate("notify.template.sh", variables)
}
