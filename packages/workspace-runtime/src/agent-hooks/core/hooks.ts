import type { StatusHookTemplate } from "@claxedo/plugin-api"
import { NOTIFY_MARKER } from "./constants"
import { loadTemplate } from "./utils"

export function generateNotifyScript(port: number, templates: readonly StatusHookTemplate[]): string {
  const aliases = templates
    .flatMap((template) =>
      [...(template.command === template.provider ? [] : [template.command]), ...(template.aliases ?? [])].map(
        (alias) => `  ${alias}) AGENT="${template.provider}" ;;`,
      ),
    )
    .join("\n")
  const guards = templates
    .flatMap((template) =>
      template.replayGuard
        ? [
            `    if [ "$HARNESS" = "${template.provider}" ] && [ -n "$${template.replayGuard.env}" ]; then exit 0; fi`,
          ]
        : [],
    )
    .join("\n")
  return loadTemplate("notify.template.sh", {
    MARKER: NOTIFY_MARKER,
    PORT: String(port),
    ALIASES: aliases,
    REPLAY_GUARDS: guards,
  })
}
