// WHAT: Brokered secrets are first-class in @claxedo/sandbox-manager — a credential the
//       sandbox may USE for outbound requests but must NEVER be able to READ. Drivers
//       declare how they honor that contract (`secretBrokering: "native" | "proxy" | "none"`),
//       and the manager FAILS CLOSED: it refuses to provision a sandbox at all rather
//       than downgrade a brokered secret to readable plaintext env.
// RUN:  bun run recipe:07-sandbox-secrets            (tsx / Node — no Bun APIs used)
// NEEDS: nothing for PART 1 (the refusal happens before any docker call).
//        PART 2 additionally needs the docker daemon and the claxedo sandbox image
//        already present locally (it is a multi-GB pull, so we never pull it for you).
// WOW:  the manager refuses to leak a secret into an unbrokered sandbox — by design.
//       `{ status: "unavailable", error: "secret_brokering_unsupported" }`, not a warning.

import { spawnSync } from "node:child_process"
import { createSandboxManager } from "@claxedo/sandbox-manager"
import { sandboxDriverCatalog } from "@claxedo/sandbox-manager/driver-catalog"
import { createDockerSandboxDriver, dockerSandboxImageFromEnv } from "@claxedo/sandbox-manager/drivers/docker"
import { createMemoryLeaseStore } from "@claxedo/sandbox-manager/stores/memory"
import { banner, dockerUp, printResult } from "./_shared"

banner({
  recipe: "07-sandbox-secrets",
  what: "brokered secrets are first-class and fail closed across sandbox drivers",
  wow: "the manager refuses to leak a secret into an unbrokered sandbox — by design",
})

// One manager, one driver, one lease store. The docker driver's metadata says
// `secretBrokering: "none"` — docker has no egress proxy that could inject a
// credential without the sandbox being able to read it.
const image = dockerSandboxImageFromEnv()
const manager = createSandboxManager({
  leaseStore: createMemoryLeaseStore(),
  driver: createDockerSandboxDriver({ image, syncLocalAuth: false }),
  appLabel: "claxedo-cookbook",
})

// ---------------------------------------------------------------------------
// PART 1 — ask for a sandbox WITH a brokered secret on an unbrokered driver.
// The refusal is decided from driver metadata inside the manager, BEFORE any
// docker command runs — this part needs no docker daemon at all.
// ---------------------------------------------------------------------------
console.log("PART 1 — brokered secret on a driver that cannot broker (no docker needed)")

const refusal = await manager.ensure("cookbook-secrets-demo", {
  homeRegion: "local",
  secrets: [
    {
      name: "GITHUB_TOKEN",
      value: "ghp_this-value-must-never-enter-the-sandbox",
      hosts: ["api.github.com"],
      header: "authorization",
    },
  ],
})

printResult("fail-closed refusal (docker driver, secretBrokering: \"none\")", refusal)

if (refusal.status !== "unavailable" || refusal.error !== "secret_brokering_unsupported") {
  console.error("UNEXPECTED: the manager did not fail closed — this is a regression")
  process.exit(1)
}

// The brokering matrix comes straight from the package's public driver
// catalog (@claxedo/sandbox-manager/driver-catalog), not hardcoded here.
// "fetch" (the fetch-bridge test driver) is not in the catalog; its source
// (src/drivers/fetch-bridge.ts) also declares secretBrokering: "none".
const matrix = Object.values(sandboxDriverCatalog).map((entry) => ({
  driver: entry.id,
  secretBrokering: entry.metadata.secretBrokering,
  brokeredSecrets:
    entry.metadata.secretBrokering === "native"
      ? "provider injects on egress; value never enters the sandbox"
      : entry.metadata.secretBrokering === "proxy"
        ? "achievable via a host-operated egress proxy (Worker injects on egress)"
        : "REFUSED — manager fails closed (secret_brokering_unsupported)",
}))

printResult("driver brokering matrix (from sandboxDriverCatalog)", matrix)

// ---------------------------------------------------------------------------
// PART 2 — the same manager happily provisions a PLAIN sandbox (no secrets)
// on the same driver. Gated: needs docker up and the sandbox image already
// local — the image bundles the workspace-runtime binary the driver boots
// (`/usr/local/bin/workspace-runtime`), so tiny stock images cannot serve it
// and the real image is too heavy to pull inside a recipe.
// ---------------------------------------------------------------------------
console.log("PART 2 — plain sandbox (no secrets) on the same docker driver")

if (!dockerUp()) {
  printResult("plain sandbox (docker)", [
    "SKIP: docker daemon is not running",
    "fix:  start Docker Desktop (or dockerd) and re-run",
  ].join("\n"))
  process.exit(0)
}

const imagePresent = spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" }).status === 0
if (!imagePresent) {
  printResult("plain sandbox (docker)", [
    "SKIP: docker image pull too heavy for a recipe",
    `      the docker driver boots ${image}`,
    "      (it must contain /usr/local/bin/workspace-runtime; it is not present locally)",
    `fix:  docker pull ${image}   # then re-run`,
  ].join("\n"))
  process.exit(0)
}

const workspaceId = `cookbook-plain-${Date.now().toString(36)}`
try {
  let result = await manager.ensure(workspaceId, { homeRegion: "local" })
  for (let attempt = 0; attempt < 5 && result.status === "provisioning"; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, result.status === "provisioning" ? result.retryAfterMs : 0))
    result = await manager.ensure(workspaceId, { homeRegion: "local" })
  }
  printResult("plain sandbox lease (no secrets — same driver, no refusal)", result)

  const stopped = await manager.destroy(workspaceId)
  const released = await manager.release(workspaceId)
  printResult("cleanup", { destroy: stopped, release: released })
} finally {
  // Safety net: the docker driver names the container after the hostId the
  // manager derives (`docker-<workspaceId>`); force-remove it even if the
  // provision failed halfway.
  spawnSync("docker", ["rm", "-f", `docker-${workspaceId}`], { stdio: "ignore" })
}
