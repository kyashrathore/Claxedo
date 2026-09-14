import { login } from "./auth/device-code"
import { whoami } from "./auth/identity"
import { connect, connectHelp } from "./commands/connect"
import { deploy } from "./commands/deploy"
import { documents, documentsUsage } from "./commands/documents"
import { hostCommand, hostUsage } from "./commands/host"
import { logout } from "./commands/logout"
import { status } from "./commands/status"
import { connectUsage } from "./connect/args"
import { errorMessage } from "./json"

function help() {
  console.log(`claxedo login
claxedo logout
${connectUsage}
${hostUsage}
claxedo status
claxedo whoami
claxedo deploy [--generate-only] [--app <name>] [--region <code>] [--yes]
${documentsUsage}

\`claxedo connect --help\` and \`claxedo host --help\` describe the machine and owner sides of remote access.`)
}

async function main(argv: string[]) {
  const [command, ...args] = argv
  if (!command || command === "help" || command === "--help" || command === "-h") {
    help()
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
  if (command === "up" || command === "down") {
    console.error("replaced by `claxedo connect` — see `claxedo connect --help`")
    process.exitCode = 1
    return
  }
  if (command === "deploy") return deploy(args)
  if (command === "documents") return documents(args)
  if (command === "status") return status()
  if (command === "whoami") return whoami()
  throw new Error(`Unknown command: ${command}`)
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(errorMessage(err))
  process.exit(1)
})
