import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"

import { D1ServiceDeploymentLock } from "./d1-deployment-lock"

const migrationPath = fileURLToPath(
  new URL("../../../../migrations/control-plane/0009_optional_service_deployment.sql", import.meta.url),
)
const active: Miniflare[] = []

async function database() {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    d1Databases: ["CONTROL_PLANE_DB"],
  })
  active.push(instance)
  const database = await instance.getD1Database("CONTROL_PLANE_DB")
  const migration = (await readFile(migrationPath, "utf8")).replace(/^\s*--.*$/gm, "")
  for (const statement of migration
    .split(/;\s*\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean)) {
    await database.prepare(statement).run()
  }
  return database
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(async () => Promise.all(active.splice(0).map((instance) => instance.dispose())))

describe("D1 optional-service deployment lock", () => {
  test("serializes every optional service in one environment/deployment scope", async () => {
    const db = await database()
    let token = 0
    const lock = new D1ServiceDeploymentLock(db, {
      leaseMs: 10_000,
      heartbeatMs: 5_000,
      token: () => `lease-${++token}`,
    })
    const entered = deferred()
    const finish = deferred()
    const first = lock.withDeploymentLock(
      { environmentId: "production", deploymentId: "deployment-1" },
      "install-workgraph",
      async () => {
        entered.resolve()
        await finish.promise
      },
    )
    await entered.promise

    await expect(
      lock.withDeploymentLock(
        { environmentId: "production", deploymentId: "deployment-1" },
        "install-documents",
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "busy" })

    finish.resolve()
    await first
    await expect(
      lock.withDeploymentLock(
        { environmentId: "production", deploymentId: "deployment-1" },
        "install-documents",
        async () => "acquired",
      ),
    ).resolves.toBe("acquired")
  })

  test("fences an expired runner and its late release cannot unlock the successor", async () => {
    const db = await database()
    let now = new Date("2026-08-28T00:00:00.000Z")
    let token = 0
    const lock = new D1ServiceDeploymentLock(db, {
      leaseMs: 1_000,
      heartbeatMs: 500,
      now: () => now,
      token: () => `lease-${++token}`,
    })
    const firstEntered = deferred()
    const finishFirst = deferred()
    const first = lock.withDeploymentLock(
      { environmentId: "production", deploymentId: "deployment-1" },
      "old-operation",
      async () => {
        firstEntered.resolve()
        await finishFirst.promise
      },
    )
    await firstEntered.promise
    now = new Date("2026-08-28T00:00:02.000Z")

    const secondEntered = deferred()
    const finishSecond = deferred()
    const second = lock.withDeploymentLock(
      { environmentId: "production", deploymentId: "deployment-1" },
      "new-operation",
      async () => {
        secondEntered.resolve()
        await finishSecond.promise
      },
    )
    await secondEntered.promise
    finishFirst.resolve()
    await expect(first).rejects.toMatchObject({ code: "lease_lost" })

    await expect(
      lock.withDeploymentLock(
        { environmentId: "production", deploymentId: "deployment-1" },
        "third-operation",
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "busy" })
    finishSecond.resolve()
    await second
  })
})
