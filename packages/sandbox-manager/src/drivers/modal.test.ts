import { describe, expect, test, vi } from "vitest"
import { createModalSandboxDriver, type ModalClientLike, type ModalSandboxLike } from "./modal"
import { SANDBOX_IMAGE } from "../image"

function sandbox(input: Partial<ModalSandboxLike> & { sandboxId?: string } = {}) {
  return {
    sandboxId: input.sandboxId ?? "modal-sb-1",
    tunnels:
      input.tunnels ?? vi.fn(async () => ({ 2593: { url: `https://${input.sandboxId ?? "modal-sb-1"}.modal.run` } })),
    terminate: input.terminate ?? vi.fn(async () => {}),
    setTags: input.setTags ?? vi.fn(async () => {}),
    snapshotFilesystem: input.snapshotFilesystem ?? vi.fn(async () => ({ imageId: "img-snapshot-1" })),
  } satisfies ModalSandboxLike
}

function client(input: Partial<ModalClientLike> = {}) {
  return {
    apps: input.apps ?? {
      fromName: vi.fn(async () => ({ app: "claxedo" })),
    },
    images: input.images ?? {
      fromRegistry: vi.fn((tag: string) => ({ imageId: tag })),
      fromId: vi.fn(async (imageId: string) => ({ imageId })),
    },
    sandboxes: input.sandboxes ?? {
      create: vi.fn(async () => sandbox()),
      fromId: vi.fn(async (sandboxId: string) => sandbox({ sandboxId })),
    },
  } satisfies ModalClientLike
}

const baseOptions = {
  tokenId: "modal-token-id",
  tokenSecret: "modal-token-secret",
  runner: "opencode",
  controlEnv: {
    relayJwksUrl: "https://relay.test/.well-known/jwks.json",
    managementJwksUrl: "https://control.test/.well-known/jwks.json",
  },
  readinessProbe: (port: number) => ({ tcp: port }),
}

const input = {
  workspaceId: "ws_1",
  homeRegion: "us-east" as const,
  epoch: 1,
  hostId: "modal-host-ws_1",
  labels: { app: "claxedo", workspaceId: "ws_1" },
}

describe("ModalSandboxDriver", () => {
  test("ensureHost creates a Modal sandbox running workspace-runtime with boot env", async () => {
    const created = sandbox()
    const modal = client({
      sandboxes: {
        create: vi.fn(async () => created),
        fromId: vi.fn(async (sandboxId: string) => sandbox({ sandboxId })),
      },
    })
    const driver = createModalSandboxDriver({
      ...baseOptions,
      client: modal,
      env: (_input, host) => ({
        WORKSPACE_RUNTIME_LEASE_ID: `lease-${host.id}`,
        WORKSPACE_RUNTIME_SANDBOX_ID: host.id,
      }),
    })

    const result = await driver.ensureHost({
      ...input,
      workspaceRoot: "/work/app",
      env: { CUSTOM_BOOT_FLAG: "yes" },
      source: { kind: "git", repoUrl: "https://repo.test/app.git", branch: "dev" },
    })
    if ("provisioning" in result) throw new Error("expected ready")

    expect(modal.apps.fromName).toHaveBeenCalledWith("claxedo", { createIfMissing: true })
    expect(modal.images.fromRegistry).toHaveBeenCalledWith(SANDBOX_IMAGE)
    expect(modal.sandboxes.create).toHaveBeenCalledWith(
      { app: "claxedo" },
      { imageId: SANDBOX_IMAGE },
      expect.objectContaining({
        name: "claxedo-ws_1",
        command: ["bash", "-lc", expect.stringContaining("/usr/local/bin/workspace-runtime")],
        workdir: "/",
        encryptedPorts: [2593],
        readinessProbe: { tcp: 2593 },
        env: expect.objectContaining({
          WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_1",
          WORKSPACE_RUNTIME_HOST_ID: "modal-host-ws_1",
          WORKSPACE_RUNTIME_DIRECTORY: "/work/app",
          WORKSPACE_RUNTIME_PORT: "2593",
          WORKSPACE_RUNTIME_RUNNER: "opencode",
          WORKSPACE_RUNTIME_RELAY_JWKS_URL: "https://relay.test/.well-known/jwks.json",
          WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL: "https://control.test/.well-known/jwks.json",
          WORKSPACE_RUNTIME_SOURCE_KIND: "git",
          WORKSPACE_RUNTIME_GIT_REPO_URL: "https://repo.test/app.git",
          WORKSPACE_RUNTIME_GIT_BRANCH: "dev",
          WORKSPACE_RUNTIME_LEASE_ID: "lease-modal-host-ws_1",
          WORKSPACE_RUNTIME_SANDBOX_ID: "modal-host-ws_1",
          CUSTOM_BOOT_FLAG: "yes",
        }),
      }),
    )
    expect(result).toMatchObject({
      sandboxId: "modal-sb-1",
      hostId: "modal-host-ws_1",
      url: "https://modal-sb-1.modal.run",
      driverResourceId: "modal-sb-1",
    })
    expect(result).not.toHaveProperty("runtimeUrl")
  })

  test("image and driver snapshot boot use Modal image ids", async () => {
    const modal = client()
    const driver = createModalSandboxDriver({ ...baseOptions, client: modal })

    await driver.ensureHost({ ...input, bootSource: { kind: "image", image: "img-prepared" } })
    await driver.ensureHost({ ...input, bootSource: { kind: "driver-snapshot", snapshotId: "img-snapshot" } })

    expect(modal.images.fromId).toHaveBeenCalledWith("img-prepared")
    expect(modal.images.fromId).toHaveBeenCalledWith("img-snapshot")
  })

  test("restricted host policies are rejected, but full egress block is passed through", async () => {
    const modal = client()
    const driver = createModalSandboxDriver({ ...baseOptions, client: modal })

    await expect(
      driver.ensureHost({
        ...input,
        net: { mode: "restricted", hosts: ["api.example.com"] },
      }),
    ).rejects.toThrow(/host-based network policy/)

    await driver.ensureHost({
      ...input,
      net: { mode: "restricted", hosts: [] },
    })

    const create = modal.sandboxes.create as ReturnType<typeof vi.fn>
    expect(create.mock.calls.at(-1)?.[2]).toMatchObject({
      blockNetwork: true,
    })
  })

  test("missing tunnel and transient driver errors are reported as provisioning", async () => {
    const noTunnel = sandbox({ tunnels: vi.fn(async () => ({})) })
    const driver = createModalSandboxDriver({
      ...baseOptions,
      client: client({
        sandboxes: {
          create: vi.fn(async () => noTunnel),
          fromId: vi.fn(async (sandboxId: string) => sandbox({ sandboxId })),
        },
      }),
    })
    expect(await driver.ensureHost(input)).toEqual({ provisioning: true, retryAfterMs: 2_000 })

    const unavailable = createModalSandboxDriver({
      ...baseOptions,
      client: client({
        sandboxes: {
          create: vi.fn(async () => {
            throw { status: 503, message: "unavailable" }
          }),
          fromId: vi.fn(async (sandboxId: string) => sandbox({ sandboxId })),
        },
      }),
    })
    expect(await unavailable.ensureHost(input)).toEqual({ provisioning: true, retryAfterMs: 2_000 })
  })

  test("stop, destroy, and snapshot operate by Modal sandbox id", async () => {
    const item = sandbox({ sandboxId: "modal-sb-2" })
    const modal = client({
      sandboxes: {
        create: vi.fn(async () => item),
        fromId: vi.fn(async () => item),
      },
    })
    const driver = createModalSandboxDriver({ ...baseOptions, client: modal })
    const target = { sandboxId: "modal-sb-2", url: "https://r.test", hostId: "modal-host" }

    await driver.stop!(target)
    await driver.destroy!(target)
    const snap = await driver.snapshot!(target)

    expect(modal.sandboxes.fromId).toHaveBeenCalledWith("modal-sb-2")
    expect(item.terminate).toHaveBeenCalledTimes(2)
    expect(item.snapshotFilesystem).toHaveBeenCalled()
    expect(snap).toEqual({ snapshotId: "img-snapshot-1" })
  })

  test("metadata exposes direct sandbox-manager semantics", () => {
    const driver = createModalSandboxDriver({ ...baseOptions, client: client() })
    expect(driver.metadata).toMatchObject({
      driverRunsIn: ["node"],
      hostStopBehavior: "terminates-host", hostResumeBehavior: "replacement-host",
      targetAccess: "relay",
    })
  })
})
