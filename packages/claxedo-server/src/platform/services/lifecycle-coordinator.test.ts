import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"

import {
  SERVICE_BINDINGS,
  SERVICE_PROTOCOL_VERSION,
  serializeServiceLifecycleMutationRequest,
  type FirstPartyServiceDescriptor,
  type ServiceLifecycleMutationRequest,
  type ServiceLifecycleMutationResponse,
  type ServiceLocalLifecycleState,
} from "@claxedo/service-contract"

import { D1ServiceInstallationStore } from "./adapters/d1-installation-store"
import {
  OptionalServiceLifecycleCoordinator,
  type OptionalServiceDeploymentDriver,
  type ServiceDeploymentLock,
  type ServiceDeploymentStep,
  type ServiceDeploymentStepIdentity,
} from "./lifecycle-coordinator"

const migrationPath = fileURLToPath(
  new URL("../../../migrations/control-plane/0001_service_installations.sql", import.meta.url),
)
const active: Miniflare[] = []
const scope = { environmentId: "staging", deploymentId: "deployment-1" }

async function createInstallationStore() {
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
  return new D1ServiceInstallationStore(database)
}

function descriptor(serviceId: "workgraph" | "documents"): FirstPartyServiceDescriptor {
  const base = {
    protocolVersion: SERVICE_PROTOCOL_VERSION,
    schemaVersion: 1,
    state: "installed_disabled" as const,
    entrypoint: serviceId === "workgraph" ? "WorkGraphServiceV1" : "DocumentsServiceV1",
    trust: { ...scope, bindingProvenance: `cloudflare-service:${serviceId}-staging` },
  }
  return serviceId === "workgraph"
    ? { ...base, serviceId, bindingName: SERVICE_BINDINGS.workgraph }
    : { ...base, serviceId, bindingName: SERVICE_BINDINGS.documents }
}

class TestDeploymentLock implements ServiceDeploymentLock {
  private tail = Promise.resolve()
  active = 0
  maxActive = 0

  async withDeploymentLock<T>(
    _scope: Readonly<{ environmentId: string; deploymentId: string }>,
    _operationId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const prior = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await prior
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    try {
      return await work()
    } finally {
      this.active -= 1
      release()
    }
  }
}

class TestDriver implements OptionalServiceDeploymentDriver {
  readonly steps = new Map<string, string>()
  readonly lifecycleOperations = new Map<string, { intent: string; response: ServiceLifecycleMutationResponse }>()
  readonly failAfterSteps = new Set<ServiceDeploymentStep>()
  readonly failAfterActions = new Set<ServiceLifecycleMutationRequest["action"]>()
  state: ServiceLocalLifecycleState | undefined
  revision: number | undefined

  constructor(
    readonly serviceId: "workgraph" | "documents",
    private readonly serviceBuildId: string,
  ) {}

  async runStep(identity: ServiceDeploymentStepIdentity, service: FirstPartyServiceDescriptor) {
    if (identity.serviceId !== this.serviceId || service.serviceId !== this.serviceId)
      throw new Error("cross-service touch")
    const intent = JSON.stringify({ identity, service })
    const prior = this.steps.get(identity.stepOperationId)
    if (prior && prior !== intent) throw new Error("step operation conflict")
    this.steps.set(identity.stepOperationId, intent)
    if (this.failAfterSteps.delete(identity.step)) throw new Error(`crash after ${identity.step}`)
  }

  async applyLifecycle(request: ServiceLifecycleMutationRequest) {
    if (request.serviceId !== this.serviceId || request.serviceBuildId !== this.serviceBuildId)
      throw new Error("provenance")
    const intent = serializeServiceLifecycleMutationRequest(request)
    const prior = this.lifecycleOperations.get(request.identity.operationId)
    if (prior) {
      if (prior.intent !== intent) throw new Error("lifecycle operation conflict")
      return prior.response
    }

    let state: ServiceLifecycleMutationResponse["state"]
    let revision: number | null
    if (request.action === "initialize_disabled") {
      if (this.state !== undefined || request.expectedRevision !== 0) throw new Error("initialize precondition")
      state = this.state = "installed_disabled"
      revision = this.revision = 1
    } else if (request.action === "record_probe") {
      if (this.revision !== request.expectedRevision || this.state !== "installed_disabled")
        throw new Error("probe precondition")
      state = this.state
      revision = this.revision = request.expectedRevision + 1
    } else if (request.action === "prepare_enable") {
      if (this.revision !== request.expectedRevision || this.state !== "installed_disabled")
        throw new Error("enable precondition")
      state = this.state = "enabling"
      revision = this.revision = request.expectedRevision + 1
    } else if (request.action === "commit_enable") {
      if (this.revision !== request.expectedRevision || this.state !== "enabling")
        throw new Error("commit precondition")
      state = this.state = "enabled"
      revision = this.revision
    } else if (request.action === "disable") {
      if (this.revision !== request.expectedRevision || this.state !== "enabled")
        throw new Error("disable precondition")
      state = this.state = "installed_disabled"
      revision = this.revision = request.expectedRevision + 1
    } else {
      if (this.revision !== request.expectedRevision || this.state !== "installed_disabled")
        throw new Error("uninstall precondition")
      this.state = undefined
      this.revision = undefined
      state = "uninstalled"
      revision = null
    }
    const response = {
      serviceId: this.serviceId,
      action: request.action,
      operationId: request.identity.operationId,
      state,
      revision,
      serviceBuildId: this.serviceBuildId,
    } satisfies ServiceLifecycleMutationResponse
    this.lifecycleOperations.set(request.identity.operationId, { intent, response })
    if (this.failAfterActions.delete(request.action)) throw new Error(`crash after ${request.action}`)
    return response
  }
}

function input(serviceId: "workgraph" | "documents", operationId: string, driver: TestDriver) {
  return {
    identity: { ...scope, operationId, occurredAt: "2026-08-28T10:00:00Z" },
    descriptor: descriptor(serviceId),
    serviceBuildId: `sha256:${serviceId}-build`,
    driver,
  }
}

afterEach(async () => Promise.all(active.splice(0).map((instance) => instance.dispose())))

describe("optional-service lifecycle coordinator", () => {
  test("only the operation that initialized a dark service may resume the pre-registration crash", async () => {
    const store = await createInstallationStore()
    const coordinator = new OptionalServiceLifecycleCoordinator(store, new TestDeploymentLock())
    const driver = new TestDriver("workgraph", "sha256:workgraph-build")

    driver.failAfterActions.add("initialize_disabled")
    await expect(coordinator.install(input("workgraph", "install-owner", driver))).rejects.toThrow(
      /initialize_disabled/,
    )
    expect(await store.get(scope, "workgraph")).toBeNull()

    await expect(coordinator.install(input("workgraph", "install-takeover", driver))).rejects.toThrow(
      /initialize precondition/,
    )
    expect(await store.get(scope, "workgraph")).toBeNull()

    await expect(coordinator.install(input("workgraph", "install-owner", driver))).resolves.toMatchObject({
      revision: 2,
    })
    expect((await store.get(scope, "workgraph"))?.revision).toBe(2)
  })

  test("resumes every two-ledger mismatch with the exact operation and leaves revisions aligned", async () => {
    const store = await createInstallationStore()
    const lock = new TestDeploymentLock()
    const coordinator = new OptionalServiceLifecycleCoordinator(store, lock)
    const driver = new TestDriver("workgraph", "sha256:workgraph-build")

    driver.failAfterActions.add("record_probe")
    await expect(coordinator.install(input("workgraph", "install-1", driver))).rejects.toThrow(/record_probe/)
    expect((await store.get(scope, "workgraph"))?.revision).toBe(1)
    expect(driver.revision).toBe(2)
    await expect(coordinator.install(input("workgraph", "install-1", driver))).resolves.toMatchObject({ revision: 2 })

    driver.failAfterActions.add("prepare_enable")
    await expect(coordinator.enable(input("workgraph", "enable-1", driver))).rejects.toThrow(/prepare_enable/)
    expect((await store.get(scope, "workgraph"))?.revision).toBe(2)
    expect(driver.state).toBe("enabling")
    await expect(coordinator.enable(input("workgraph", "enable-1", driver))).resolves.toMatchObject({ revision: 3 })
    expect(driver.state).toBe("enabled")

    driver.failAfterSteps.add("drain_operations")
    await expect(coordinator.disable(input("workgraph", "disable-1", driver))).rejects.toThrow(/drain_operations/)
    expect((await store.get(scope, "workgraph"))?.revision).toBe(4)
    expect(driver.revision).toBe(3)
    await expect(coordinator.disable(input("workgraph", "disable-1", driver))).resolves.toMatchObject({ revision: 4 })
    expect(driver.revision).toBe(4)

    driver.failAfterActions.add("uninstall")
    await expect(coordinator.uninstall(input("workgraph", "uninstall-1", driver))).rejects.toThrow(/uninstall/)
    expect(await store.get(scope, "workgraph")).not.toBeNull()
    await expect(coordinator.uninstall(input("workgraph", "uninstall-1", driver))).resolves.toBeUndefined()
    expect(await store.get(scope, "workgraph")).toBeNull()
    expect(driver.state).toBeUndefined()
  })

  test("serializes both services on one deployment lock and never dispatches across service drivers", async () => {
    const store = await createInstallationStore()
    const lock = new TestDeploymentLock()
    const coordinator = new OptionalServiceLifecycleCoordinator(store, lock)
    const workgraph = new TestDriver("workgraph", "sha256:workgraph-build")
    const documents = new TestDriver("documents", "sha256:documents-build")

    await Promise.all([
      coordinator.install(input("workgraph", "install-workgraph", workgraph)),
      coordinator.install(input("documents", "install-documents", documents)),
    ])

    expect(lock.maxActive).toBe(1)
    expect([...workgraph.steps.values()].every((value) => value.includes('"serviceId":"workgraph"'))).toBe(true)
    expect([...documents.steps.values()].every((value) => value.includes('"serviceId":"documents"'))).toBe(true)
    expect((await store.list(scope)).map((row) => row.descriptor.serviceId)).toEqual(["documents", "workgraph"])
  })

  test("rejects a driver or descriptor from another service before provisioning anything", async () => {
    const store = await createInstallationStore()
    const driver = new TestDriver("documents", "sha256:documents-build")
    const coordinator = new OptionalServiceLifecycleCoordinator(store, new TestDeploymentLock())
    await expect(coordinator.install({ ...input("workgraph", "wrong-driver", driver), driver })).rejects.toMatchObject({
      code: "driver_mismatch",
    })
    expect(driver.steps.size).toBe(0)
    expect(await store.list(scope)).toEqual([])
  })
})
