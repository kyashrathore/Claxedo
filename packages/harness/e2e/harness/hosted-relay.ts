import { spawn } from "node:child_process"
import path from "node:path"
import { REPO_ROOT } from "./node-loader"
import { HOSTED_SIGNING_PRIVATE_KEY, HOSTED_SIGNING_PUBLIC_KEY } from "./hosted-keys"

export async function startHostedRelay(input: { port: number; controlPlaneUrl: string; certificate: string }) {
  const child = spawn("bun", ["src/main.ts"], {
    cwd: path.join(REPO_ROOT, "packages/workspace-relay"),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      CLAXEDO_WORKSPACE_RELAY_HOST: "127.0.0.1",
      CLAXEDO_WORKSPACE_RELAY_PORT: String(input.port),
      CLAXEDO_RELAY_RESOLVER_URL: `${input.controlPlaneUrl}/internal/relay`,
      CLAXEDO_RELAY_RESOLVER_TOKEN: "hosted-e2e-relay-resolver-token",
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: HOSTED_SIGNING_PUBLIC_KEY,
      CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM: HOSTED_SIGNING_PRIVATE_KEY,
      CLAXEDO_RELAY_HOST_PUBLIC_KEY_PEM: HOSTED_SIGNING_PUBLIC_KEY,
      CLAXEDO_RELAY_DRAIN_TIMEOUT_MS: "1000",
      NODE_EXTRA_CA_CERTS: input.certificate,
    },
  })
  try {
    await new Promise<void>((resolve, reject) => {
      let output = ""
      const timer = setTimeout(() => reject(new Error(`hosted relay did not start: ${output.slice(-2000)}`)), 30_000)
      const onData = (data: Buffer) => {
        output += data.toString()
        if (output.includes("[workspace-relay] listening")) {
          clearTimeout(timer)
          resolve()
        }
      }
      child.stdout?.on("data", onData)
      child.stderr?.on("data", onData)
      child.once("exit", (code) => {
        clearTimeout(timer)
        reject(new Error(`hosted relay exited ${code}: ${output.slice(-2000)}`))
      })
    })
  } catch (error) {
    child.kill("SIGTERM")
    throw error
  }
  return {
    url: `http://127.0.0.1:${input.port}`,
    close: async () => {
      child.kill("SIGTERM")
      await new Promise<void>((resolve) => child.once("exit", () => resolve()))
    },
  }
}
