#!/usr/bin/env node

import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(import.meta.dirname, "..")

/**
 * Vars the deployed Worker carries that `wrangler.toml` cannot: they name one
 * deployment's control plane and browser origin. `wrangler deploy` replaces the
 * Worker's whole plain-text var set with what the config and `--var` declare, so
 * omitting either silently drops it — `CLAXEDO_CENTRAL_URL` is the resolver base
 * the host-tunnel serving-generation fence derives from, and `CLAXEDO_APP_ORIGINS`
 * is the CORS allowlist.
 */
const DEPLOYMENT_VARS = ["CLAXEDO_CENTRAL_URL", "CLAXEDO_APP_ORIGINS"] as const

export type RelayWorkerDeployInput = Readonly<{
  workerName: string
  centralUrl: string
  appOrigins: string
  dryRun?: boolean
}>

export function relayWorkerDeployCommand(input: RelayWorkerDeployInput) {
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(input.workerName)) {
    throw new Error("the relay Worker name must be a valid Cloudflare Worker identifier")
  }
  for (const [name, value] of [
    ["CLAXEDO_CENTRAL_URL", input.centralUrl],
    ["CLAXEDO_APP_ORIGINS", input.appOrigins],
  ] as const) {
    if (!value.trim()) throw new Error(`${name} is required to deploy the relay Worker`)
  }
  return [
    "deploy",
    "--config",
    "wrangler.toml",
    // `[env.staging]` carries the uncapped channel limit and the APAC location
    // hint; only the Worker name differs per deployment.
    "--env",
    "staging",
    "--name",
    input.workerName,
    "--var",
    `CLAXEDO_CENTRAL_URL:${input.centralUrl}`,
    "--var",
    `CLAXEDO_APP_ORIGINS:${input.appOrigins}`,
    ...(input.dryRun ? ["--dry-run", "--outdir", "dist-worker"] : []),
  ]
}

export async function verifyRelayHealth(
  input: Readonly<{
    relayUrl: string
    attempts?: number
    intervalMs?: number
    fetcher?: (url: string) => Promise<Response>
    wait?: (milliseconds: number) => Promise<void>
  }>,
) {
  const fetcher = input.fetcher ?? ((url: string) => fetch(url, { signal: AbortSignal.timeout(15_000) }))
  const wait = input.wait ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const attempts = input.attempts ?? 12
  let failure = new Error(`${input.relayUrl} was not probed`)
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const body: unknown = await (await fetcher(`${input.relayUrl.replace(/\/$/, "")}/health`)).json()
      if (!healthy(body)) {
        throw new Error(`relay /health reported ${JSON.stringify(body)}`)
      }
      return body
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
    }
    if (attempt < attempts) await wait(input.intervalMs ?? 5_000)
  }
  throw failure
}

function healthy(body: unknown): body is { ok: true; mode: "cloudflare-durable-object" } {
  if (typeof body !== "object" || body === null) return false
  const fields: Partial<Record<"ok" | "mode", unknown>> = body
  return fields.ok === true && fields.mode === "cloudflare-durable-object"
}

function required(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required to deploy the relay Worker`)
  return value
}

async function run(args: string[]) {
  const executable = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler")
  const child = spawn(executable, args, { cwd: ROOT, env: process.env, stdio: ["ignore", "inherit", "inherit"] })
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve))
  if (code !== 0) throw new Error(`wrangler ${args.slice(0, 2).join(" ")} exited with ${code}`)
}

async function main() {
  const dryRun = process.argv.includes("--dry-run")
  const workerName = required("CLAXEDO_RELAY_WORKER_NAME")
  const relayUrl = required("CLAXEDO_RELAY_URL")
  const args = relayWorkerDeployCommand({
    workerName,
    centralUrl: required("CLAXEDO_RELAY_CENTRAL_URL"),
    appOrigins: required("CLAXEDO_RELAY_APP_ORIGINS"),
    dryRun,
  })
  console.log(
    [`worker  ${workerName}`, `health  ${relayUrl}/health`, `vars    ${DEPLOYMENT_VARS.join(", ")}`, "", `  wrangler ${args.join(" ")}`].join(
      "\n",
    ),
  )
  await run(args)
  if (dryRun) return
  const health = await verifyRelayHealth({ relayUrl })
  console.log(`relay ${workerName} deployed and serving ${health.mode}`)
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) await main()
