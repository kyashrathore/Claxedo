import { spawn } from "node:child_process"
import path from "node:path"
import { config } from "../config"
import { registerHost } from "../host/register"
import { readHostState } from "../host/state"
import { startHost } from "../host/runtime"

type UpOptions = {
  path: string
  name?: string
  detach: boolean
  internalHost: boolean
}

function parse(args: string[]): UpOptions {
  let target = "."
  let name: string | undefined
  let detach = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === "--detach") {
      detach = true
      continue
    }
    if (arg === "--name") {
      name = args[i + 1]
      i += 1
      continue
    }
    if (arg?.startsWith("--name=")) {
      name = arg.slice("--name=".length)
      continue
    }
    if (arg && !arg.startsWith("-")) target = arg
  }
  return { path: path.resolve(target), ...(name ? { name } : {}), detach, internalHost: false }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForDetached(directory: string) {
  for (let i = 0; i < 30; i += 1) {
    const record = (await readHostState()).hosts.find((item) => item.directory === directory)
    if (record) return record
    await sleep(500)
  }
}

export async function up(args: string[], internalHost = false) {
  const options = { ...parse(args), internalHost }
  if (options.detach && !internalHost) {
    const child = spawn(
      process.execPath,
      [process.argv[1]!, "host", options.path, ...(options.name ? ["--name", options.name] : [])],
      {
        detached: true,
        stdio: "ignore",
        env: process.env,
      },
    )
    child.unref()
    const record = await waitForDetached(options.path)
    if (record) {
      console.log(`${record.appUrl}/w/${record.workspaceId}`)
      return
    }
    console.log("Starting claxedo host in the background")
    return
  }

  const registered = await registerHost({ directory: options.path, ...(options.name ? { name: options.name } : {}) })
  const result = await startHost(registered, options.detach)
  console.log(`${config().appUrl}/w/${registered.workspaceId}`)
  console.log(`Serving ${registered.directory} on http://127.0.0.1:${result.runtimePort}`)
}
