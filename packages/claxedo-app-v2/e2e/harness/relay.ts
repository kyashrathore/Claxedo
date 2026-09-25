import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import path from "node:path"
import { REPO_ROOT } from "./node-loader"
import { captureOutput, stopProcess, type OwnedProcess } from "./process"

const RELAY_DIR = path.join(REPO_ROOT, "packages/workspace-relay")
const START_TIMEOUT_MS = 30_000

export type Relay = { url: string; resolverToken: string; log: () => string; close: () => Promise<void> }

export type RelayInput = {
  port: number
  resolverToken: string
  controlPlaneUrl: string
  runtimePublicPem: string
  allowedOrigins: readonly string[]
}

export function relayResolverToken() {
  return randomBytes(24).toString("hex")
}

function waitForListening(owned: OwnedProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      owned.child.stdout?.off("data", check)
      reject(new Error(`The workspace relay did not start:\n${owned.log()}`))
    }, START_TIMEOUT_MS)
    const check = () => {
      if (!owned.log().includes("[workspace-relay] listening on")) return
      clearTimeout(deadline)
      owned.child.stdout?.off("data", check)
      resolve()
    }
    owned.child.stdout?.on("data", check)
    owned.child.once("exit", (code) => {
      clearTimeout(deadline)
      reject(new Error(`The workspace relay exited with ${code}:\n${owned.log()}`))
    })
    check()
  })
}

export async function startRelay(input: RelayInput): Promise<Relay> {
  const child = spawn("bun", ["src/main.ts"], {
    cwd: RELAY_DIR,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      NODE_ENV: "test",
      CLAXEDO_WORKSPACE_RELAY_HOST: "127.0.0.1",
      CLAXEDO_WORKSPACE_RELAY_PORT: String(input.port),
      CLAXEDO_RELAY_RESOLVER_URL: `${input.controlPlaneUrl}/internal/relay`,
      CLAXEDO_RELAY_RESOLVER_TOKEN: input.resolverToken,
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: input.runtimePublicPem,
      CLAXEDO_RELAY_ALLOWED_ORIGINS: input.allowedOrigins.join(","),
      CLAXEDO_RELAY_SYNTHETIC_PROBE_DISABLED: "1",
      CLAXEDO_RELAY_TARGET_CACHE_TTL_MS: "1",
      CLAXEDO_TELEMETRY_MODE: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const owned = captureOutput(child)
  try {
    await waitForListening(owned)
  } catch (error) {
    await stopProcess(child)
    throw error
  }
  return {
    url: `http://127.0.0.1:${input.port}`,
    resolverToken: input.resolverToken,
    log: owned.log,
    close: () => stopProcess(child),
  }
}
