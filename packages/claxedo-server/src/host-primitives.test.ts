import { describe, expect, test, vi } from "vitest"
import type { SessionWriteMode } from "./governance/architecture"
import {
  claimChannelDelivery,
  createHostedControlPlaneServices,
  createControlPlaneRelayProvider,
  createDurableSessionLog,
  customVerifierAuthAdapter,
  createMemoryLeaseStore,
  createMirrorController,
  createProjectionDedupStore,
  createProjectionStore,
  createSandboxManager,
  createSqliteLeaseStore,
  recordChannelRunAudit,
  sandboxLease,
  type WorkspaceAuthority,
  type SandboxRowEvent,
  type SandboxLeaseRow,
} from "./index"

function lease(input: Partial<SandboxLeaseRow> & { workspace_id: string }): SandboxLeaseRow {
  return {
    workspace_id: input.workspace_id,
    lease_id: input.lease_id ?? "lease-1",
    home_region: input.home_region ?? "us-east",
    epoch: input.epoch ?? 1,
    status: input.status ?? "ready",
    driver: input.driver ?? "modal",
    driver_resource_id: input.driver_resource_id ?? null,
    driver_snapshot_id: input.driver_snapshot_id ?? null,
    sandbox_id: input.sandbox_id ?? null,
    url: input.url ?? null,
    retry_count: input.retry_count ?? 0,
    next_retry_at: input.next_retry_at ?? null,
    last_heartbeat_at: input.last_heartbeat_at ?? null,
    last_activity_at: input.last_activity_at ?? null,
    last_health_failure_at: input.last_health_failure_at ?? null,
    last_error: input.last_error ?? null,
    compute_class: input.compute_class ?? null,
    accel_base_image_id: input.accel_base_image_id ?? null,
    accel_prepared_image_id: input.accel_prepared_image_id ?? null,
    accel_snapshot_id: input.accel_snapshot_id ?? null,
    checkpoint: input.checkpoint ?? null,
    persistence: input.persistence ?? null,
    restore: input.restore ?? null,
    created_at: input.created_at ?? 1,
    updated_at: input.updated_at ?? 1,
  }
}

describe("host primitives package surface", () => {
  test("exports existing lifecycle, storage, relay, projection, and channel primitives from the package root", () => {
    expect(createSandboxManager).toBeTypeOf("function")
    expect(createMemoryLeaseStore).toBeTypeOf("function")
    expect(createSqliteLeaseStore).toBeTypeOf("function")
    expect(createControlPlaneRelayProvider).toBeTypeOf("function")
    expect(createProjectionStore).toBeTypeOf("function")
    expect(createDurableSessionLog).toBeTypeOf("function")
    expect(createProjectionDedupStore).toBeTypeOf("function")
    expect(claimChannelDelivery).toBeTypeOf("function")
    expect(recordChannelRunAudit).toBeTypeOf("function")
    expect(sandboxLease({ workspaceId: "ws_1" }).workspaceId).toBe("ws_1")
  })

  test("creates an instance-owned mirror controller with injected event subscription", () => {
    let handler: ((event: SandboxRowEvent) => void) | undefined
    const unsubscribe = vi.fn()
    const adapter = {
      syncLease: vi.fn(async () => {}),
      removeLease: vi.fn(async () => {}),
      syncPreparedImage: vi.fn(async () => {}),
      syncSnapshot: vi.fn(async () => {}),
      audit: vi.fn(async () => {}),
    }
    const controller = createMirrorController({
      adapter,
      subscribe(next) {
        handler = next
        return unsubscribe
      },
    })

    controller.start()
    handler?.({ type: "lease_updated", lease: lease({ workspace_id: "ws_1" }), changed: ["status"] })
    controller.stop()

    expect(adapter.syncLease).toHaveBeenCalledWith(expect.objectContaining({ workspace_id: "ws_1" }))
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  test("composes hosted control plane primitives with a structural workspace authority", () => {
    const authority = {
      usersMe: vi.fn(async () => ({ id: "user_1" })),
      listWorkspaces: vi.fn(async () => []),
      openWorkspace: vi.fn(async () => ({ allowed: true, workspace: { workspace_id: "ws_1" } })),
      authorizeWorkspaceOpen: vi.fn(async () => {}),
      authorizeSessionRead: vi.fn(async () => {}),
      recordRuntimeAccessToken: vi.fn(async () => {}),
      runtimeAccessTokenActive: vi.fn(async () => ({ active: true })),
      revokeRuntimeAccessToken: vi.fn(async () => {}),
      listWorkspaceAgentExtensions: vi.fn(async () => []),
      listSessions: vi.fn(async () => []),
      readSessionMessages: vi.fn(async () => ({ messages: [] })),
      upsertSessionVisibility: vi.fn(async () => ({})),
      replaceSessionVisibility: vi.fn(async () => ({})),
      deleteSessionVisibility: vi.fn(async () => ({})),
      auditAllow: vi.fn(async () => {}),
      auditDeny: vi.fn(async () => {}),
      // `satisfies Partial<...>` keeps compile-time drift checking on the mocked
      // subset while the cast widens to the full authority surface.
    } satisfies Partial<WorkspaceAuthority> as unknown as WorkspaceAuthority
    const lifecycle = createSandboxManager({
      leaseStore: createMemoryLeaseStore(),
      driver: {
        id: "fake",
        metadata: {
          driverRunsIn: ["node"],
          hostStopBehavior: "suspends-host", hostResumeBehavior: "same-host",
          targetAccess: "relay",
          secretBrokering: "none",
          egressControl: "hosts-and-cidrs",
          persistence: {
            resume: "same-sandbox",
            capture: "none",
            clone: false,
            captureSource: "not-applicable",
            retention: "not-applicable",
            restoreMount: "not-applicable",
          },
        },
        ensureHost: vi.fn(async () => ({
          sandboxId: "sandbox_1",
          url: "http://runtime.example.test",
          hostId: "host_1",
        })),
      },
    })
    const centralBag = {
      mode: () => "central_canonical" as SessionWriteMode,
      sync_session_meta: vi.fn(async () => {}),
      sync_session_metas: vi.fn(async () => {}),
      put_session_meta: vi.fn(async () => {}),
      delete_session_meta: vi.fn(async () => {}),
      session_meta: vi.fn(async () => undefined),
      session_metas: vi.fn(async () => new Map()),
      list_session_metas: vi.fn(async () => []),
      tagged_session_metas: vi.fn(async () => []),
      sync_session_messages: vi.fn(async () => {}),
      persist_message_event: vi.fn(),
      read_session_messages: vi.fn(() => []),
      read_session_max_event_ordinal: vi.fn(() => 0),
      subscribe_message_replay: vi.fn(() => () => {}),
    }
    const services = createHostedControlPlaneServices(
      {
        projectionStore: createProjectionStore(centralBag),
        durableSessionLog: createDurableSessionLog(centralBag),
        sessionWriteMode: centralBag.mode,
      },
      {
        auth: customVerifierAuthAdapter({
          issuer: "https://auth.example.test",
          verifier: vi.fn(async () => ({
            mode: "signed" as const,
            user: {
              subject: "user_1",
              tokenIdentifier: "external:user_1",
              issuer: "https://auth.example.test",
            },
          })),
        }),
        credentials: {
          listCredentials: vi.fn(async () => []),
          getCredentialByProvider: vi.fn(async () => undefined),
          putCredential: vi.fn(async (input) => ({
            id: `cred_${input.provider_id}`,
            provider_id: input.provider_id,
            kind: input.kind,
            source: input.source,
            secure_ref: "external:secret",
            status: "available" as const,
            created_at: 1,
            updated_at: 1,
          })),
          deleteCredential: vi.fn(async () => true),
          deleteCredentialsByProvider: vi.fn(async () => 0),
          updateCredentialStatus: vi.fn(async () => {}),
          syncLocalCredentials: vi.fn(async () => ({ synced: [], existing: [], missing: [], failed: [] })),
        },
        extensionPolicy: { agentExtensionPolicyOverrides: [] },
        relay: {
          relayUrl: "https://relay.example.test",
          resolverToken: "resolver",
          runtimeAccessTokenSigner: vi.fn(async () => ({
            runtimeAccessToken: "rat",
            tokenExpiresAt: 1,
            jti: "rat_1",
          })),
          hostTunnelTokenSigner: vi.fn(async () => ({
            hostTunnelToken: "htt",
            tokenExpiresAt: 1,
            jti: "htt_1",
          })),
        },
        sandbox: { defaultDriver: "daytona", sandboxManager: lifecycle },
        telemetry: { capture: vi.fn() },
        authority: authority,
      },
    )

    expect(services.authority).toBe(authority)
    expect(services.sandbox.sandboxManager).toBe(lifecycle)
  })
})
