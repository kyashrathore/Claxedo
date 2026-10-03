import { generateKeyPairSync } from "node:crypto"

import type { SandboxDriverEnsureInput, SandboxTarget } from "../src/contract"
import { createBoatSandboxDriver } from "../src/drivers/boat"
import { createBoatClient } from "../src/drivers/boat-client"
import { sandboxLease } from "../src/stores/memory"

const args = process.argv.slice(2)
const image = args.find((arg) => arg.startsWith("--image="))?.slice("--image=".length)
const apiKey = process.env.BOAT_API_KEY?.trim()
if (!args.includes("--yes-live") || !image || !apiKey) {
  console.error("usage: BOAT_API_KEY=<key> bun scripts/boat-live-check.ts --yes-live --image=<workspace-runtime image>")
  console.error("Creates one billable Boat sandbox, boots the image in it, stops, resumes and deletes it.")
  process.exit(2)
}

const started = Date.now()
const workspaceId = `live-check-${started.toString(36)}`
const relayVerifyPem = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()
const driver = createBoatSandboxDriver({ apiKey, image, controlEnv: { relayVerifyPem } })
const client = createBoatClient({ apiKey })
let sandboxId: string | undefined

function report(step: string, facts: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ step, elapsedMs: Date.now() - started, ...facts }))
}

async function timed<T>(step: string, run: () => Promise<T>, facts: (value: T) => Record<string, unknown> = () => ({})) {
  const stepStarted = Date.now()
  const value = await run()
  report(step, { ms: Date.now() - stepStarted, ...facts(value) })
  return value
}

const ensure: SandboxDriverEnsureInput = {
  workspaceId,
  homeRegion: "us-east",
  epoch: 1,
  labels: { app: "claxedo-live-check", workspaceId },
  async onResource(resource) {
    sandboxId = resource.sandboxId
    report("created", { sandboxId })
  },
}

function booted(result: SandboxTarget | { provisioning: true } | undefined): SandboxTarget {
  if (!result || "provisioning" in result) throw new Error("the sandbox did not become ready within the driver's provisioning deadline")
  return result
}

async function publicHealth(url: string) {
  const response = await fetch(new URL("/global/health", url), { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`public /global/health answered ${response.status}`)
  return response.status
}

async function archived(id: string) {
  const until = Date.now() + 300_000
  for (let sandbox = await client.get(id); sandbox.state !== "archived"; sandbox = await client.get(id)) {
    if (Date.now() >= until) throw new Error(`the sandbox is still ${sandbox.state} five minutes after stop`)
    await new Promise((resolve) => setTimeout(resolve, 3_000))
  }
  return "archived"
}

async function inWorkspace(id: string, command: string) {
  const result = await client.command(id, { command: `docker exec claxedo-runtime sh -c ${JSON.stringify(command)}` })
  if (result.exitCode !== 0) throw new Error(`workspace command exited ${result.exitCode}`)
  return result.stdout.trim()
}

async function containerFacts(id: string) {
  const command = [
    "systemctl is-active docker",
    "docker ps -a --filter name=claxedo-runtime --format '{{.Status}} created {{.CreatedAt}}'",
    "docker inspect --format 'restart={{.HostConfig.RestartPolicy.Name}} started={{.State.StartedAt}}' claxedo-runtime",
    "sudo -n journalctl -u docker -b --no-pager -n 15 -o short-precise 2>&1 | cut -c1-240",
    "docker logs --tail 20 claxedo-runtime 2>&1",
  ].join("; ")
  const result = await client.command(id, { command })
  return result.stdout.split("\n").filter(Boolean)
}

async function deleteSandbox() {
  if (!sandboxId) return
  const id = sandboxId
  sandboxId = undefined
  await timed("deleted", () => client.delete(id), () => ({ sandboxId: id })).catch((error: unknown) => {
    report("delete failed: delete it by hand", { sandboxId: id, error: String(error) })
    process.exitCode = 1
  })
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void deleteSandbox().finally(() => process.exit(130)))
}

try {
  const first = await timed("booted", async () => booted(await driver.ensureHost(ensure)), (target) => ({ sandboxId: target.sandboxId, url: target.url }))
  await timed("public health", () => publicHealth(first.url), (status) => ({ status }))
  await timed("workspace marker written", () => inWorkspace(first.sandboxId, `echo ${workspaceId} > .live-check`))
  await timed("stop requested", () => client.stop(first.sandboxId))
  await timed("stopped", () => archived(first.sandboxId), (state) => ({ state }))
  const lease = sandboxLease({ workspaceId, driver: "boat", sandboxId: first.sandboxId, hostId: first.hostId, url: first.url, status: "stopped" })
  const second = await timed("resumed", async () => booted(await driver.resumeHost?.({ lease, ensure })), (target) => ({ url: target.url, sameUrl: target.url === first.url }))
  await timed("public health after resume", () => publicHealth(second.url), (status) => ({ status }))
  const marker = await timed("workspace marker read", () => inWorkspace(second.sandboxId, "cat .live-check"), (text) => ({ survived: text === workspaceId }))
  if (marker !== workspaceId) throw new Error("the workspace did not survive stop and resume")
  report("passed")
} catch (error) {
  const errors = error instanceof AggregateError ? error.errors : [error]
  report("failed", { errors: errors.map((cause) => (cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause))) })
  if (sandboxId) report("container", { lines: await containerFacts(sandboxId).catch((cause: unknown) => [String(cause)]) })
  process.exitCode = 1
} finally {
  await deleteSandbox()
}
