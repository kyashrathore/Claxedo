import { describe, expect, test } from "vitest"

import { WorkGraphSettlerRuntime, WorkGraphWakeLaneRuntime, runWorkGraphServiceScheduled } from "./background"
import type { WorkGraphServiceLifecycleReader } from "./service"

const deployment = {
  environmentId: "environment-staging",
  deploymentId: "deployment-staging",
  serviceBuildId: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  bindingName: "WORKGRAPH_SERVICE" as const,
  entrypoint: "WorkGraphServiceV1" as const,
  bindingProvenance: "cloudflare-service:workgraph-staging",
}

function lifecycle(state: "installed_disabled" | "enabled" | undefined): WorkGraphServiceLifecycleReader {
  return {
    read: async () =>
      state
        ? {
            ...deployment,
            state,
            revision: state === "installed_disabled" ? 1 : 2,
          }
        : undefined,
  }
}

describe("dark WorkGraph background resources", () => {
  test.each([undefined, "installed_disabled"] as const)(
    "does no cron, settlement, wake, or alarm work while lifecycle is %s",
    async (state) => {
      const input = { ...deployment, lifecycle: lifecycle(state) }
      const settler = new WorkGraphSettlerRuntime(input)
      const wakes = new WorkGraphWakeLaneRuntime(input)

      await expect(runWorkGraphServiceScheduled("* * * * *", input)).resolves.toBeUndefined()
      await expect(runWorkGraphServiceScheduled("*/15 * * * *", input)).resolves.toBeUndefined()
      await expect(settler.alarm()).resolves.toBeUndefined()
      await expect(wakes.alarm()).resolves.toBeUndefined()
      await expect(
        settler.fetch(new Request("https://workgraph-settler.internal/nudge", { method: "POST" })),
      ).resolves.toMatchObject({ status: 409 })
      await expect(
        wakes.fetch(new Request("https://workgraph-wake.internal/nudge", { method: "POST" })),
      ).resolves.toMatchObject({ status: 409 })
    },
  )

  test("fails visibly instead of pretending the not-yet-ported runtime ran after enable", async () => {
    const input = { ...deployment, lifecycle: lifecycle("enabled") }
    await expect(runWorkGraphServiceScheduled("* * * * *", input)).rejects.toMatchObject({
      code: "runtime_unavailable",
    })
    await expect(new WorkGraphSettlerRuntime(input).alarm()).rejects.toMatchObject({ code: "runtime_unavailable" })
    await expect(new WorkGraphWakeLaneRuntime(input).alarm()).rejects.toMatchObject({ code: "runtime_unavailable" })
  })
})
