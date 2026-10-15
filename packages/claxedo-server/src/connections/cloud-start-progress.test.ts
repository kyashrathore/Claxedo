import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { SandboxTargetResult } from "@claxedo/sandbox-manager"
import type { ControlPlaneServices } from "../authority/services"
import type { SandboxStartAnswer } from "../workspace/sandbox-start"
import { hostedConnectionInfo, hostedConnectionStatus } from "./hosted-connection-info"
import type { FirstLease } from "../workspace/cloud-workspace-start"

const auth = {
  mode: "signed",
  token: "token",
  user: { subject: "user_1", tokenIdentifier: "user_1", issuer: "https://issuer.test" },
} as unknown as SignedControlPlaneAuth

const LEASED: FirstLease = { admission: { capLease: async () => undefined }, usage: undefined }
const NOW = 1_800_000_000_000

function booting(epoch: number, phases: string[]): SandboxTargetResult {
  return {
    status: "unavailable",
    reason: "runtime_lease_not_ready",
    leaseStatus: "acquiring",
    start: { epoch, requestedAt: NOW - 72_000, startedAt: NOW - 72_000, bootMode: "resume", markedAt: NOW - 30_000, phases },
  } as SandboxTargetResult
}

function subject(target: SandboxTargetResult) {
  const read = vi.fn(async () => target)
  const services = {
    authority: {
      usersMe: vi.fn(async () => ({ subject: "user_1", actor_id: "user_1", actor_kind: "human", actor_public_id: "user_1", actor_name: "Signed User" })),
      openWorkspace: vi.fn(async () => ({
        allowed: true,
        role: "owner",
        workspace: { workspace_id: "ws_1", org_id: "org_1", project_id: "project_1", backing: "cloud-vm", home_region: "us-east" },
      })),
    },
    sandbox: { sandboxManager: { target: read } },
    telemetry: { capture: vi.fn() },
  } as unknown as ControlPlaneServices
  const options = (answer: SandboxStartAnswer | undefined) => ({
    defaultHomeRegion: "us-east",
    relayUrl: "wss://relay.test",
    sandboxStart: async () => answer ?? { status: "unavailable" as const, homeRegion: "us-east" },
    sandboxInFlight: async () => answer,
  })
  return { services, options, read }
}

const JOINED: SandboxStartAnswer = { status: "provisioning", retryAfterMs: 2_000, epoch: 2, homeRegion: "us-east", joined: true }

beforeEach(() => {
  vi.spyOn(Date, "now").mockImplementation(() => NOW)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("a cloud start's progress in the connection answer", () => {
  test("a poll that joins the start reports the steps its lease has recorded, timed by the server, with the boot path the lease names", async () => {
    const { services, options, read } = subject(booting(2, ["lease_decision", "provider_ready"]))
    const result = await hostedConnectionInfo(services, options(JOINED), auth, "ws_1", LEASED)
    expect(result).toEqual({
      connection: {
        status: "provisioning",
        workspaceId: "ws_1",
        homeRegion: "us-east",
        retryAfterMs: 2_000,
        bootMode: "resume",
        progress: { phases: ["lease_decision", "provider_ready"], sinceStartMs: 72_000, sinceStepMs: 30_000 },
      },
    })
    expect(read).toHaveBeenCalledTimes(1)
  })

  test("a read of a start in flight reports the same progress", async () => {
    const { services, options } = subject(booting(2, ["lease_decision"]))
    const result = await hostedConnectionStatus(services, options(JOINED), auth, "ws_1")
    expect(result).toMatchObject({ connection: { status: "provisioning", bootMode: "resume", progress: { phases: ["lease_decision"], sinceStartMs: 72_000, sinceStepMs: 30_000 } } })
  })

  test("the recorded start of another epoch is not this start's progress", async () => {
    const { services, options } = subject(booting(1, ["lease_decision", "image_ready", "runtime_ready"]))
    const result = await hostedConnectionInfo(services, options(JOINED), auth, "ws_1", LEASED)
    expect(result).toEqual({ connection: { status: "provisioning", workspaceId: "ws_1", homeRegion: "us-east", retryAfterMs: 2_000 } })
  })

  test("a lease waiting out a retry reports the start the person is waiting on beside the failure it retries", async () => {
    const waiting = { ...booting(3, ["lease_decision"]), leaseStatus: "unavailable", retryAfterMs: 15_000, failure: { kind: "provider", message: "quota exceeded", retrying: true } } as SandboxTargetResult
    const { services, options } = subject(waiting)
    const result = await hostedConnectionStatus(services, options(undefined), auth, "ws_1")
    expect(result).toEqual({
      connection: {
        status: "provisioning",
        workspaceId: "ws_1",
        homeRegion: "us-east",
        failure: "quota exceeded",
        retryAfterMs: 15_000,
        bootMode: "resume",
        progress: { phases: ["lease_decision"], sinceStartMs: 72_000, sinceStepMs: 30_000 },
      },
    })
  })
})
