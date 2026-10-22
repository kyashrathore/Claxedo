import { generateKeyPairSync } from "node:crypto"

import { SANDBOX_IMAGE_LABEL, type SandboxDriverEnsureInput, type SandboxTarget } from "../src/contract"
import { createBoatSandboxDriver } from "../src/drivers/boat"
import { createBoatClient } from "../src/drivers/boat-client"
import { sandboxLease } from "../src/stores/memory"

const args = process.argv.slice(2)
const flag = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const imageA = flag("image-a")
const imageB = flag("image-b")
const cycles = Number(flag("cycles") ?? "10")
const apiKey = process.env.BOAT_API_KEY?.trim()
if (!args.includes("--yes-live") || !imageA || !imageB || !apiKey || !Number.isSafeInteger(cycles) || cycles < 1) {
  console.error("usage: BOAT_API_KEY=<key> bun scripts/boat-update-rig.ts --yes-live --image-a=<image> --image-b=<image> [--cycles=10] [--running]")
  console.error("Creates one billable Boat sandbox on image A, then per cycle stops it, wakes it on the other image's driver (which keeps the booted one) and at once runs that driver's update, alternating images; deletes the sandbox at the end.")
  console.error("--running skips the stop: each update runs on a machine that kept serving since the last one.")
  process.exit(2)
}
const stopping = !args.includes("--running")

const started = Date.now()
const workspaceId = `update-rig-${started.toString(36)}`
const relayVerifyPem = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()
const drivers = new Map([imageA, imageB].map((image) => [image, createBoatSandboxDriver({ apiKey, image, controlEnv: { relayVerifyPem } })]))
const client = createBoatClient({ apiKey })
let sandboxId: string | undefined

function report(step: string, facts: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ step, elapsedMs: Date.now() - started, ...facts }))
}

function ensureInput(epoch: number, phases: Record<string, number>, updateImage?: true): SandboxDriverEnsureInput {
  const at = Date.now()
  return {
    workspaceId,
    homeRegion: "us-east",
    epoch,
    labels: { app: "claxedo-update-rig", workspaceId },
    source: { kind: "git", repoUrl: "https://github.com/octocat/Hello-World" },
    ...(updateImage ? { updateImage } : {}),
    async onResource(resource) {
      sandboxId = resource.sandboxId
    },
    async onMachineReady() {
      phases.machineReadyMs = Date.now() - at
    },
    async onImageReady() {
      phases.imageReadyMs = Date.now() - at
    },
  }
}

function ready(result: SandboxTarget | { provisioning: true } | undefined): SandboxTarget {
  if (!result || "provisioning" in result) throw new Error("the sandbox did not become ready within the driver's provisioning deadline")
  return result
}

async function archived(id: string) {
  const until = Date.now() + 300_000
  for (let sandbox = await client.get(id); sandbox.state !== "archived"; sandbox = await client.get(id)) {
    if (Date.now() >= until) throw new Error(`the sandbox is still ${sandbox.state} five minutes after stop`)
    await new Promise((resolve) => setTimeout(resolve, 3_000))
  }
}

/** What the machine looked like when a step failed: disk, images, the persistent trees, Docker's journal and the container. */
async function machineFacts(id: string) {
  const command = [
    "df -h / | tail -1",
    "docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}'",
    "sudo -n du -sh claxedo-persistent/image-* 2>/dev/null",
    "docker ps -a --format '{{.Names}} {{.Image}} {{.Status}}'",
    "sudo -n journalctl -u docker -b --no-pager -n 30 -o short-precise 2>&1 | cut -c1-300",
    "docker logs --tail 20 claxedo-runtime 2>&1",
  ].join("; echo ---; ")
  const result = await client.command(id, { command, timeoutSeconds: 60 })
  return result.stdout.split("\n").filter(Boolean)
}

async function step(name: string, run: () => Promise<SandboxTarget>, phases: Record<string, number>) {
  const stepStarted = Date.now()
  try {
    const target = await run()
    report(name, { ok: true, ms: Date.now() - stepStarted, booted: target.labels?.[SANDBOX_IMAGE_LABEL], ...phases })
    return target
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    report(name, { ok: false, ms: Date.now() - stepStarted, error: message, ...phases })
    if (sandboxId) report(`${name}: machine`, { lines: await machineFacts(sandboxId).catch((cause: unknown) => [String(cause)]) })
    return undefined
  }
}

async function deleteSandbox() {
  if (!sandboxId) return
  const id = sandboxId
  sandboxId = undefined
  await client.delete(id).then(() => report("deleted", { sandboxId: id }), (error: unknown) => {
    report("delete failed: delete it by hand", { sandboxId: id, error: String(error) })
    process.exitCode = 1
  })
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void deleteSandbox().finally(() => process.exit(130)))
}

const failures: Array<{ cycle: number; step: string }> = []
try {
  const coldPhases: Record<string, number> = {}
  let target = await step("cold start", async () => ready(await drivers.get(imageA)!.ensureHost(ensureInput(1, coldPhases))), coldPhases)
  if (!target) throw new Error("the cold start failed")
  let current = imageA
  for (let cycle = 1; cycle <= cycles; cycle++) {
    const next = current === imageA ? imageB : imageA
    const driver = drivers.get(next)!
    const epoch = cycle + 1
    if (stopping) {
      await client.stop(target.sandboxId)
      await archived(target.sandboxId)
      const wakePhases: Record<string, number> = {}
      const stopped = sandboxLease({ workspaceId, driver: "boat", sandboxId: target.sandboxId, hostId: target.hostId, url: target.url, status: "stopped" })
      const woken = await step(`cycle ${cycle} wake`, async () => ready(await driver.resumeHost!({ lease: stopped, ensure: ensureInput(epoch, wakePhases) })), wakePhases)
      if (!woken) {
        failures.push({ cycle, step: "wake" })
        continue
      }
      target = woken
    }
    const updatePhases: Record<string, number> = {}
    const running = sandboxLease({ workspaceId, driver: "boat", sandboxId: target.sandboxId, hostId: target.hostId, url: target.url, status: "ready" })
    const updated = await step(`cycle ${cycle} update to ${next}`, async () => ready(await driver.resumeHost!({ lease: running, ensure: ensureInput(epoch, updatePhases, true) })), updatePhases)
    if (!updated || updated.labels?.[SANDBOX_IMAGE_LABEL] !== next) {
      failures.push({ cycle, step: "update" })
      continue
    }
    target = updated
    current = next
  }
  report("summary", { cycles, failures })
  if (failures.length) process.exitCode = 1
} catch (error) {
  report("failed", { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) })
  process.exitCode = 1
} finally {
  await deleteSandbox()
}
