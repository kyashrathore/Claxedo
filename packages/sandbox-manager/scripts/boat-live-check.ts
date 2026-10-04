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
  console.error("Creates one billable Boat sandbox, boots the image in it with a public repository checked out, stops, resumes and deletes it.")
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
  source: { kind: "git", repoUrl: "https://github.com/octocat/Hello-World" },
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

const MARKERS = [".live-check", "/root/.claxedo/.live-check", "/root/.workspace-runtime/.live-check"]
const STATE_FILES = "find /root/.claxedo /root/.workspace-runtime -type f | wc -l"
const WORKSPACE_GIT = "stat -c %u /workspace && git -C /workspace rev-parse --git-path shallow --abbrev-ref HEAD"

async function inWorkspace(id: string, command: string) {
  const result = await client.command(id, { command: `docker exec claxedo-runtime sh -c ${JSON.stringify(command)}` })
  if (result.exitCode !== 0) throw new Error(`workspace command exited ${result.exitCode}: ${result.stderr.trim().slice(-400)}`)
  return result.stdout.trim()
}

function gitFacts(output: string) {
  const [ownerUid, shallow, branch] = output.split("\n")
  return { ownerUid, shallow, branch }
}

async function vmFacts(id: string) {
  const result = await client.command(id, {
    command: "cat /proc/sys/kernel/random/boot_id; docker inspect --format '{{.State.StartedAt}}' claxedo-runtime",
  })
  const [bootId, startedAt] = result.stdout.trim().split("\n")
  return { bootId, startedAt, state: (await client.get(id)).state }
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
  await timed("vm tools", () => client.command(first.sandboxId, { command: "command -v flock || echo missing" }), (result) => ({ flock: result.stdout.trim() }))
  await timed("workspace git", () => inWorkspace(first.sandboxId, WORKSPACE_GIT), gitFacts)
  await timed("markers written", () => inWorkspace(first.sandboxId, MARKERS.map((file) => `echo ${workspaceId} > ${file}`).join(" && ")))
  const stateBefore = await timed("runtime state files", () => inWorkspace(first.sandboxId, STATE_FILES), (count) => ({ count }))
  await timed("stop requested", () => client.stop(first.sandboxId))
  await timed("stopped", () => archived(first.sandboxId), (state) => ({ state }))
  const lease = sandboxLease({ workspaceId, driver: "boat", sandboxId: first.sandboxId, hostId: first.hostId, url: first.url, status: "stopped" })
  const second = await timed("resumed", async () => booted(await driver.resumeHost?.({ lease, ensure })), (target) => ({ url: target.url, sameUrl: target.url === first.url }))
  await timed("public health after resume", () => publicHealth(second.url), (status) => ({ status }))
  await timed("workspace git after resume", () => inWorkspace(second.sandboxId, WORKSPACE_GIT), gitFacts)
  const read = MARKERS.map((file) => `cat ${file} 2>/dev/null || echo missing`).join("; ")
  const markers = await timed("markers read", async () => (await inWorkspace(second.sandboxId, read)).split("\n"), (lines) => ({
    survived: Object.fromEntries(MARKERS.map((file, index) => [file, lines[index] === workspaceId])),
  }))
  await timed("runtime state files after resume", () => inWorkspace(second.sandboxId, STATE_FILES), (count) => ({ count, before: stateBefore }))
  await timed("image pulls this boot", () => client.command(second.sandboxId, { command: "sudo -n journalctl -u docker -b --no-pager | grep -c 'image pulled'" }), (result) => ({ count: result.stdout.trim() }))
  if (markers.some((line) => line !== workspaceId)) throw new Error("runtime or workspace state did not survive stop and resume")
  const running = sandboxLease({ ...lease, url: second.url, status: "ready" })
  const before = await timed("before resuming a running sandbox", () => vmFacts(second.sandboxId), (facts) => facts)
  const resumedRunning = await timed("resume of a running sandbox", async () => {
    const outcome = await driver.resumeHost?.({ lease: running, ensure }).then(
      (target) => ({ answered: "provisioning" in target ? "provisioning" : "ready" }),
      (error: unknown) => ({ answered: "error", error: error instanceof Error ? error.message : String(error) }),
    )
    return { ...outcome, ...(await vmFacts(second.sandboxId)) }
  }, (facts) => facts)
  report("running resume", { vmRebooted: resumedRunning.bootId !== before.bootId, containerRestarted: resumedRunning.startedAt !== before.startedAt })
  await timed("public health after running resume", () => publicHealth(second.url), (status) => ({ status }))
  report("passed")
} catch (error) {
  const errors = error instanceof AggregateError ? error.errors : [error]
  report("failed", { errors: errors.map((cause) => (cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause))) })
  if (sandboxId) report("container", { lines: await containerFacts(sandboxId).catch((cause: unknown) => [String(cause)]) })
  process.exitCode = 1
} finally {
  await deleteSandbox()
}
