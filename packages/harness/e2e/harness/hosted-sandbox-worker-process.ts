import { spawn } from "node:child_process"
import path from "node:path"
import { TSX_LOADER } from "./node-loader"

type Input = {
  root: string
  port: number
  token: string
  certificate: string
  key: string
  controlPlaneUrl: string
  modelUrl: string
  gitUrl: string
  relayUrl: string
}

/**
 * The sandbox Worker stand-in runs in its own Node process: it owns the
 * brokering proxy every sandbox's model traffic crosses, and that proxy is
 * Node's `http`/`tls` bridge, which the flow runner's Bun process does not
 * reproduce byte for byte.
 */
export async function startHostedSandboxWorkerProcess(input: Input) {
  const child = spawn(process.env.CLAXEDO_E2E_NODE ?? "node", ["--conditions=development", "--import", TSX_LOADER, path.join(import.meta.dirname, "hosted-sandbox-worker.ts")], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: input.root, XDG_CONFIG_HOME: path.join(input.root, ".config"), NODE_EXTRA_CA_CERTS: input.certificate, CLAXEDO_E2E_HOSTED_SANDBOX_WORKER: JSON.stringify(input) },
  })
  try {
    await new Promise<void>((resolve, reject) => {
      let output = ""
      const timer = setTimeout(() => reject(new Error(`hosted sandbox worker did not start: ${output.slice(-2000)}`)), 60_000)
      const onData = (data: Buffer) => {
        output += data.toString()
        if (output.includes("[hosted-sandbox-worker] ready")) {
          clearTimeout(timer)
          resolve()
        }
      }
      child.stdout?.on("data", onData)
      child.stderr?.on("data", onData)
      child.once("exit", (code) => {
        clearTimeout(timer)
        reject(new Error(`hosted sandbox worker exited ${code}: ${output.slice(-3000)}`))
      })
    })
    child.stderr?.on("data", (data: Buffer) => process.stderr.write(data))
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM")
      await new Promise<void>((resolve) => child.once("exit", () => resolve()))
    }
    throw error
  }
  return {
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM")
        await new Promise<void>((resolve) => child.once("exit", () => resolve()))
      }
    },
  }
}
