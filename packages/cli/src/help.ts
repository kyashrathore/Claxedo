import { hostUsage } from "./commands/host"
import { connectUsage } from "./connect/args"
import { PLUGIN_COMMANDS } from "./plugin-commands"

export function helpText(): string {
  return `claxedo login
claxedo logout
${connectUsage}
${hostUsage}
claxedo status
claxedo doctor
claxedo whoami
${PLUGIN_COMMANDS.map((command) => command.usage).join("\n")}
claxedo --version

\`claxedo connect --help\` and \`claxedo host --help\` describe the machine and owner sides of remote access.`
}
