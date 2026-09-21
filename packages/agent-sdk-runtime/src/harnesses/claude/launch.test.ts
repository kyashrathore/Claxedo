import { expect, test } from "bun:test"
import { volatileLaunchOwnership, type CreationIdentity } from "../../launch"
import { identityFromSpawn, ownDirectClaudeLaunch } from "./launch"

function identity(startedAtMs: number): CreationIdentity {
  return {
    pid: 4242,
    processGroupId: 4242,
    startSecond: String(Math.floor(startedAtMs / 1000)),
    bootTime: "1",
    parentPid: 1,
    startedAtMs,
    source: "darwin-ps",
  }
}

test("a process that began after the spawn is the one this launcher started", () => {
  const spawnedAt = 1_000_000
  expect(identityFromSpawn(identity(spawnedAt + 5), spawnedAt)).toBeDefined()
})

test("a pid whose process began before the spawn is a stranger the launcher never started", () => {
  const spawnedAt = 1_000_000
  // Well outside the one-second resolution the platform readers offer.
  expect(identityFromSpawn(identity(spawnedAt - 60_000), spawnedAt)).toBeUndefined()
})

test("a process that began in the same second as the spawn is accepted", () => {
  // `startedAtMs` is floored to the second, so a process started milliseconds
  // after the spawn reads as marginally earlier than the clock sampled here.
  const spawnedAt = 1_000_900
  expect(identityFromSpawn(identity(1_000_000), spawnedAt)).toBeDefined()
})

test("a launch whose pid was recycled records no identity, so its retirement signals nothing", async () => {
  const ownership = volatileLaunchOwnership()
  const launch = ownDirectClaudeLaunch({
    proc: { pid: 4242 },
    ownership,
    workspaceId: "ws",
    // The pid now answers for a process that started long before this spawn.
    readIdentity: async () => identity(Date.now() - 60_000),
  })

  const result = await launch.retire({ termGraceMs: 10, killVerifyMs: 10 })
  expect(result).toMatchObject({
    leader: "unknown",
    descendants: "unknown",
    error: { code: "ownership_unverified" },
  })
  expect(result.signals).toEqual([])
})

test("a launch whose identity matches the spawn is recorded and retirable", async () => {
  const ownership = volatileLaunchOwnership()
  const recorded: CreationIdentity[] = []
  const launch = ownDirectClaudeLaunch({
    proc: { pid: 4242 },
    ownership: {
      ...ownership,
      recordIdentity: async (launchId, observed) => {
        recorded.push(observed)
        await ownership.recordIdentity(launchId, observed)
      },
    },
    workspaceId: "ws",
    readIdentity: async () => identity(Date.now()),
  })

  const result = await launch.retire({ termGraceMs: 10, killVerifyMs: 10 })
  expect(recorded).toHaveLength(1)
  // The identity was established, so retirement reached a real verdict rather
  // than refusing for want of one.
  expect(result.error?.code).not.toBe("ownership_unverified")
})
