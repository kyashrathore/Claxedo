import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { renderSessionHostWranglerConfig } from "../../../claxedo-server/scripts/deploy/wrangler-config"
import { HOSTED_SIGNING_PRIVATE_KEY, HOSTED_SIGNING_PUBLIC_KEY } from "./hosted-keys"
import { waitForHealth } from "./health"
import { captureOutput, stopProcess } from "./process"

export async function startHostedRelay(input: { root: string; port: number; controlPlaneUrl: string; certificate: string; allowedOrigins: readonly string[];
  modelUrl: string }) {
  const root = path.join(input.root, "relay")
  const home = path.join(root, "home")
  await fs.mkdir(home, { recursive: true })
  const sessionHostDirectory = path.join(root, "session-host")
  await fs.mkdir(sessionHostDirectory, { recursive: true })
  const sessionHostConfig = path.join(sessionHostDirectory, "wrangler.toml")
  await fs.writeFile(sessionHostConfig, renderSessionHostWranglerConfig({
    workerName: "claxedo-session-host", controlPlaneWorkerName: "claxedo-hosted-e2e", configDirectory: sessionHostDirectory,
    variables: {
      WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL: `${input.controlPlaneUrl}/api/runtime-authority/session-authorize`,
      WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM: HOSTED_SIGNING_PUBLIC_KEY,
    },
  }))
  const child = spawn(process.env.CLAXEDO_E2E_NODE ?? "node", [path.join(import.meta.dirname, "relay-workerd.mjs")], {
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      XDG_DATA_HOME: path.join(home, ".local/share"),
      NODE_ENV: "test",
      WRANGLER_SEND_METRICS: "false",
      NODE_EXTRA_CA_CERTS: input.certificate,
      CLAXEDO_E2E_RELAY_WORKER: JSON.stringify({
        root, port: input.port, certificate: input.certificate,
        sessionHost: { config: sessionHostConfig, controlPlaneUrl: input.controlPlaneUrl, modelUrl: input.modelUrl },
        bindings: {
          CLAXEDO_RELAY_RESOLVER_URL: `${input.controlPlaneUrl}/internal/relay`,
          CLAXEDO_RELAY_RESOLVER_TOKEN: "hosted-e2e-relay-resolver-token",
          CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: HOSTED_SIGNING_PUBLIC_KEY,
          CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM: HOSTED_SIGNING_PRIVATE_KEY,
          CLAXEDO_RELAY_HOST_PUBLIC_KEY_PEM: HOSTED_SIGNING_PUBLIC_KEY,
          CLAXEDO_RELAY_ALLOWED_ORIGINS: input.allowedOrigins.join(","),
        },
      }),
    },
  })
  const owned = captureOutput(child)
  const url = `http://127.0.0.1:${input.port}`
  const close = () => stopProcess(child, { processGroup: true })
  try {
    await waitForHealth(`${url}/.well-known/jwks.json`, {
      label: "relay workerd", child, log: owned.log,
      ready: () => owned.log().includes("[relay-workerd] ready"),
    })
  } catch (error) {
    await close()
    throw error
  }
  return { url, close }
}
