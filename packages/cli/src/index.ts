import { login } from "./auth/device-code"
import { whoami } from "./auth/identity"
import { connect, connectHelp } from "./commands/connect"
import { hostCommand } from "./commands/host"
import { logout } from "./commands/logout"
import { status } from "./commands/status"
import { helpText } from "./help"
import { errorMessage } from "./json"
import { cliCommandContext, pluginCommand } from "./plugin-commands"
import { cliVersion } from "./version"

function help() {
  console.log(helpText())
}

async function main(argv: string[]) {
  const [command, ...args] = argv
  if (!command || command === "help" || command === "--help" || command === "-h") {
    help()
    return
  }
  if (command === "--version" || command === "-v") {
    console.log(cliVersion())
    return
  }
  if (command === "login") return login()
  if (command === "logout") return logout()
  if (command === "connect") {
    if (args[0] === "--help" || args[0] === "-h") {
      console.log(connectHelp)
      return
    }
    process.exitCode = await connect(args)
    return
  }
  if (command === "host") return hostCommand(args)
  if (command === "status") return status()
  if (command === "whoami") return whoami()
  const contributed = pluginCommand(command)
  if (contributed) return contributed.run(args, cliCommandContext())
  throw new Error(`Unknown command: ${command}`)
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(errorMessage(err))
  process.exit(1)
})
