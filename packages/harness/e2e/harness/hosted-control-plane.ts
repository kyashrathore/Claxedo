import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { SERVER_DIR } from "./node-loader"
import { writeHostedE2eWranglerConfig } from "./hosted-wrangler-config"
import { HOSTED_SIGNING_PRIVATE_KEY, HOSTED_SIGNING_PUBLIC_KEY } from "./hosted-keys"

type Input = {
  root: string
  port: number
  sandboxOrigin: string
  gitUrl: string
  relayUrl: string
  credentials: { key: string; certificate: string }
}

export async function hostedCertificate(root: string) {
  const key = path.join(root, "hosted-key.pem")
  const certificate = path.join(root, "hosted-cert.pem")
  const generated = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      key,
      "-out",
      certificate,
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { encoding: "utf8" },
  )
  if (generated.error) throw generated.error
  if (generated.status !== 0) throw new Error(`openssl failed: ${generated.stderr}`)
  return { key, certificate }
}

function ready(child: ChildProcess, marker: string) {
  return new Promise<void>((resolve, reject) => {
    let output = ""
    const timer = setTimeout(() => reject(new Error(`hosted Miniflare did not start: ${output.slice(-2000)}`)), 90_000)
    const onData = (data: Buffer) => {
      output += data.toString()
      if (output.includes(marker)) {
        clearTimeout(timer)
        resolve()
      }
    }
    child.stdout?.on("data", onData)
    child.stderr?.on("data", onData)
    child.once("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`hosted Miniflare exited ${code}: ${output.slice(-3000)}`))
    })
  })
}

function requestProvisioning(child: ChildProcess, input: Record<string, string>, field: "claim" | "token") {
  return new Promise<string>((resolve, reject) => {
    const id = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
    const timer = setTimeout(() => {
      child.off("message", listener)
      reject(new Error(`Hosted ${field} provisioning timed out`))
    }, 10_000)
    const listener = (message: unknown) => {
      if (!message || typeof message !== "object" || !("id" in message) || message.id !== id) return
      clearTimeout(timer)
      child.off("message", listener)
      const value = Reflect.get(message, field)
      if (typeof value === "string") resolve(value)
      else reject(new Error("error" in message ? String(message.error) : `Hosted provisioning returned no ${field}`))
    }
    child.on("message", listener)
    child.send({ id, ...input })
  })
}

export async function startHostedControlPlane(input: Input) {
  const credentials = input.credentials
  const config = await writeHostedE2eWranglerConfig()
  const attemptsFile = path.join(input.root, "hosted-outbound-attempts.jsonl")
  const child = spawn(process.env.CLAXEDO_E2E_NODE ?? "node", ["--import", "tsx", "scripts/e2e/hosted-miniflare.ts"], {
    cwd: SERVER_DIR,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      NODE_EXTRA_CA_CERTS: credentials.certificate,
      CLAXEDO_E2E_HOSTED_MINIFLARE: JSON.stringify({
        config,
        root: input.root,
        port: input.port,
        certificate: credentials.certificate,
        key: credentials.key,
        sandboxOrigin: input.sandboxOrigin,
        gitUrl: input.gitUrl,
        relayUrl: input.relayUrl,
        signingPrivateKey: HOSTED_SIGNING_PRIVATE_KEY,
        signingPublicKey: HOSTED_SIGNING_PUBLIC_KEY,
      }),
    },
  })
  try {
    await ready(child, "[hosted-miniflare] ready")
    child.stderr?.on("data", (data: Buffer) => process.stderr.write(data))
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM")
      await new Promise<void>((resolve) => child.once("exit", () => resolve()))
    }
    await fs.rm(config, { force: true })
    throw error
  }
  return {
    url: `https://127.0.0.1:${input.port}`,
    certificate: credentials.certificate,
    outboundAttempts: async () => {
      try {
        return (await fs.readFile(attemptsFile, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { method: string; url: string })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
        throw error
      }
    },
    inviteMember: (ownerSubject: string, inviteeSubject: string) =>
      requestProvisioning(child, { ownerSubject, inviteeSubject }, "token"),
    provisionOwnerClaim: (subject: string) => requestProvisioning(child, { subject }, "claim"),
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM")
        await new Promise<void>((resolve) => child.once("exit", () => resolve()))
      }
      await fs.rm(config, { force: true })
    },
  }
}
