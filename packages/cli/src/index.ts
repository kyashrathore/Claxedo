import { login } from "./auth/device-code"
import { whoami } from "./auth/identity"
import { creds } from "./commands/creds"
import { deploy } from "./commands/deploy"
import { down } from "./commands/down"
import { logout } from "./commands/logout"
import { status } from "./commands/status"
import { up } from "./commands/up"
import { errorMessage } from "./json"

function help() {
  console.log(`claxedo login
claxedo logout
claxedo up [path] [--name <display>] [--detach]
claxedo down [workspaceId]
claxedo status
claxedo whoami
claxedo deploy [--generate-only] [--app <name>] [--region <code>] [--yes]
claxedo creds sync --remote <url> [--token <credentials-token>] [--yes]`)
}

async function main(argv: string[]) {
  const [command, ...args] = argv
  if (!command || command === "help" || command === "--help" || command === "-h") {
    help()
    return
  }
  if (command === "login") return login()
  if (command === "logout") return logout()
  if (command === "up") return up(args)
  if (command === "host") return up(args, true)
  if (command === "deploy") return deploy(args)
  if (command === "creds") return creds(args)
  if (command === "down") return down(args)
  if (command === "status") return status()
  if (command === "whoami") return whoami()
  throw new Error(`Unknown command: ${command}`)
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(errorMessage(err))
  process.exit(1)
})
