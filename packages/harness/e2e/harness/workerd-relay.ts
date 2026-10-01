import { spawn } from "node:child_process"
import { generateKeyPairSync } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { captureOutput, stopProcess } from "./process"
import { waitForHealth } from "./health"

export type WorkerdRelayInput = {
  root: string
  port: number
  controlPlaneUrl: string
  resolverToken: string
  runtimePublicPem: string
  allowedOrigins?: readonly string[]
  signingKeys?: { privatePem: string; publicPem: string }
  certificate?: string
}

export async function startWorkerdRelay(input: WorkerdRelayInput) {
  const root = await fs.mkdtemp(path.join(input.root, "relay-workerd-"))
  const home = path.join(root, "home")
  await fs.mkdir(home)
  const pair = input.signingKeys ? undefined : generateKeyPairSync("ed25519")
  const keys = input.signingKeys ?? {
    privatePem: pair!.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: pair!.publicKey.export({ type: "spki", format: "pem" }).toString(),
  }
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
      ...(input.certificate ? { NODE_EXTRA_CA_CERTS: input.certificate } : {}),
      CLAXEDO_E2E_RELAY_WORKER: JSON.stringify({
        root, port: input.port, certificate: input.certificate,
        bindings: {
          CLAXEDO_RELAY_RESOLVER_URL: `${input.controlPlaneUrl}/internal/relay`,
          CLAXEDO_RELAY_RESOLVER_TOKEN: input.resolverToken,
          CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: input.runtimePublicPem,
          CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM: keys.privatePem,
          CLAXEDO_RELAY_HOST_PUBLIC_KEY_PEM: keys.publicPem,
          ...(input.allowedOrigins ? { CLAXEDO_RELAY_ALLOWED_ORIGINS: input.allowedOrigins.join(",") } : {}),
        },
      }),
    },
  })
  const owned = captureOutput(child)
  const url = `http://127.0.0.1:${input.port}`
  const close = async () => {
    await stopProcess(child, { processGroup: true })
    await fs.rm(root, { recursive: true, force: true })
  }
  try {
    await waitForHealth(`${url}/.well-known/jwks.json`, {
      label: "relay workerd", child, log: owned.log,
      ready: () => owned.log().includes("[relay-workerd] ready"),
    })
  } catch (error) {
    await close()
    throw error
  }
  return { url, resolverToken: input.resolverToken, log: owned.log, close }
}
