import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const serverRoot = path.resolve(import.meta.dirname, "../..")

type Command = {
  name: string
  cwd: string
  cmd: string
  args: string[]
}

export function workerSafeCommands(): Command[] {
  return [
    {
      name: "central.worker.dry_run",
      cwd: serverRoot,
      cmd: "wrangler",
      args: ["deploy", "--env", "staging", "--dry-run", "--outdir", "dist-worker"],
    },
  ]
}

async function run(command: Command) {
  console.log(`${command.name}: running ${[command.cmd, ...command.args].join(" ")}`)
  const child = spawn(command.cmd, command.args, {
    cwd: command.cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  })
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve))
  if (code !== 0) {
    console.error(`${command.name}: failed`)
    process.exit(code ?? 1)
  }
  console.log(`${command.name}: succeeded`)
}

async function main() {
  for (const command of workerSafeCommands()) await run(command)
  console.log("worker safe check succeeded")
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  await main()
}
