import { describe, expect, test, vi } from "vitest"
import type { SessionMeta } from "@claxedo/server-core/session/meta/index"
import type { SessionWriteMode } from "@claxedo/server-core/platform/runtime/profile"
import { createDurableSessionLog } from "@claxedo/server-core/platform/auth/durable-session-log"
import { createProjectionStore } from "./projection-store"
import { controlPlaneAuthContext, localOnlyAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import {
  ControlPlaneCompositionError,
  createControlPlaneServices,
  createHostedControlPlaneServices,
  type HostedControlPlaneServicesOptions,
  type WorkspaceAuthority,
} from "./services"
import { testManagedSessionAuthority } from "../test-support/managed-session-authority"

function fakePorts(sync = fakeSync()) {
  return {
    projectionStore: createProjectionStore(sync),
    durableSessionLog: createDurableSessionLog(sync),
    sessionWriteMode: sync.mode as () => SessionWriteMode,
  }
}

function fakeSync() {
  return {
    mode: () => "central_canonical",
    sync_session_meta: vi.fn(async () => {}),
    sync_session_metas: vi.fn(async () => {}),
    sync_session_messages: vi.fn(async () => {}),
    put_session_meta: vi.fn(async () => {}),
    delete_session_meta: vi.fn(async () => {}),
    session_meta: vi.fn(async (_sessionID: string): Promise<SessionMeta | undefined> => undefined),
    session_metas: vi.fn(async () => new Map()),
    list_session_metas: vi.fn(async () => []),
    tagged_session_metas: vi.fn(async () => []),
    persist_message_event: vi.fn(),
    read_session_messages: vi.fn(() => []),
    // The central-store backend requires `read_session_max_event_ordinal` for
    // message-replay sequencing; mocks were missing it.
    read_session_max_event_ordinal: vi.fn(() => 0),
  }
}

function hostedOptions(
  overrides: Partial<HostedControlPlaneServicesOptions> = {},
): HostedControlPlaneServicesOptions {
  return {
    auth: {
      config: {
        enabled: true,
        issuer: "https://issuer.example.test",
        jwksUrl: "https://issuer.example.test/.well-known/jwks.json",
      },
      verifier: vi.fn(),
    },
    credentials: {
      listCredentials: vi.fn(async () => []),
      getCredentialByProvider: vi.fn(async () => undefined),
      putCredential: vi.fn(async (input) => ({
        id: `cred_${input.provider_id}`,
        provider_id: input.provider_id,
        kind: input.kind,
        source: input.source,
        secure_ref: "hosted:secret",
        status: "available" as const,
        created_at: 1,
        updated_at: 1,
        revision: 1,
        incarnation: `cred_${input.provider_id}`,
      })),
      deleteCredential: vi.fn(async () => true),
      deleteCredentialsByProvider: vi.fn(async () => 0),
      updateCredentialStatus: vi.fn(async () => {}),
      syncLocalCredentials: vi.fn(async () => ({ synced: [], existing: [], missing: [], failed: [] })),
      accountSelections: async () => ({}),
      setAccountSources: async () => ({}),
    },
    relay: {
      relayUrl: "https://relay.example.test",
      resolverToken: "resolver-secret",
      runtimeAccessTokenSigner: vi.fn(),
      hostTunnelTokenSigner: vi.fn(),
    },
    sandbox: { defaultDriver: "modal" },
    telemetry: { capture: vi.fn() },
    authority: fakeAuthority(),
    ...overrides,
  }
}

function fakeAuthority(): WorkspaceAuthority {
  const fn = () => vi.fn()
  return testManagedSessionAuthority({
    usersMe: fn(),
    listOrgs: fn(),
    resolveOrgId: fn(),
    projectRole: fn(),
    authorizeProject: fn(),
    authorizeChannelProject: fn(),
    authorizeChannelWorkspace: fn(),
    authorizeWorkspaceOpen: fn(),
    openWorkspace: fn(),
    listWorkspaces: fn(),
    deleteWorkspace: fn(),
    createCloudWorkspace: fn(),
    authorizeSessionRead: fn(),
    listSessions: fn(),
    readSessionMessages: fn(),
    syncSessionMessages: fn(),
    upsertSessionVisibility: fn(),
    replaceSessionVisibility: fn(),
    recordRuntimeAccessToken: fn(),
    runtimeAccessTokenActive: fn(),
    revokeRuntimeAccessToken: fn(),
    revokeRuntimeAccessTokensForWorkspaceUser: fn(),
    auditAllow: fn(),
    auditDeny: fn(),
  })
}

describe("control-plane services", () => {
  test("uses injected central-store ports when provided", () => {
    const sync = fakeSync()
    const services = createControlPlaneServices(fakePorts(sync))

    expect(services.projectionStore.put_session_meta).toBe(sync.put_session_meta)
    expect(services.projectionStore.read_session_messages).toBe(sync.read_session_messages)
  })

  test("central-store ports are accepted as the composition input and delegate to the backend", () => {
    // The seam is ports-in: callers pass the ports, and the composition holds
    // no injected bag of its own.
    const sync = fakeSync()
    const services = createControlPlaneServices(fakePorts(sync))

    // Every projection-store port method is the raw backend method (identity),
    // so a call on the port is literally a call on the injected bag.
    expect(services.projectionStore.sync_session_meta).toBe(sync.sync_session_meta)
    expect(services.projectionStore.sync_session_metas).toBe(sync.sync_session_metas)
    expect(services.projectionStore.sync_session_messages).toBe(sync.sync_session_messages)
    expect(services.projectionStore.put_session_meta).toBe(sync.put_session_meta)
    expect(services.projectionStore.delete_session_meta).toBe(sync.delete_session_meta)
    expect(services.projectionStore.session_meta).toBe(sync.session_meta)
    expect(services.projectionStore.session_metas).toBe(sync.session_metas)
    expect(services.projectionStore.list_session_metas).toBe(sync.list_session_metas)
    expect(services.projectionStore.tagged_session_metas).toBe(sync.tagged_session_metas)
    expect(services.projectionStore.read_session_messages).toBe(sync.read_session_messages)
    expect(services.projectionStore.read_session_max_event_ordinal).toBe(
      sync.read_session_max_event_ordinal,
    )

    // Durable-session-log ports delegate to the backend replay methods.
    expect(services.durableSessionLog.persist_message_event).toBe(sync.persist_message_event)

    // Behavioral delegation: invoking a port method actually calls the stub.
    void services.projectionStore.sync_session_meta(undefined, { id: "s1" })
    expect(sync.sync_session_meta).toHaveBeenCalledWith(undefined, { id: "s1" })
    services.durableSessionLog.persist_message_event("s1", { type: "x" })
    expect(sync.persist_message_event).toHaveBeenCalledWith("s1", { type: "x" })
  })

  test("an injected authority is returned unchanged by service composition", () => {
    // Plain composition passthrough: whatever authority bag is injected comes
    // back on `services.authority` by identity, regardless of env.
    const authority = { getWorkspace: vi.fn() } as never
    const services = createControlPlaneServices(fakePorts(), {
      authority: authority,
    })
    expect(services.authority).toBe(authority)

    // The hosted `requiredHostedDependency` path also returns it unchanged
    // (it passes the "workspace authority" required-dependency
    // check and lands on the composed services by identity).
    const hostedAuthority = hostedOptions().authority
    const hosted = createHostedControlPlaneServices(fakePorts(), hostedOptions({
      authority: hostedAuthority,
    }))
    expect(hosted.authority).toBe(hostedAuthority)
  })

  test("composes auth explicitly and accepts an adapter override", async () => {
    const services = createControlPlaneServices(fakePorts(), {
      auth: localOnlyAuthAdapter("test composition"),
    })

    await expect(controlPlaneAuthContext(new Request("http://localhost"), services.auth)).resolves.toEqual({
      mode: "unsigned-local",
      reason: "test composition",
    })
  })

  test("accepts explicit store, credentials, relay, sandbox, and telemetry inputs", () => {
    const base = createControlPlaneServices(fakePorts(), { authority: null })
    const capture = vi.fn()
    const credentials = {} as never
    const runtimeAccessTokenSigner = vi.fn() as never
    const hostTunnelTokenSigner = vi.fn() as never
    const services = createControlPlaneServices(
      { projectionStore: base.projectionStore, durableSessionLog: base.durableSessionLog },
      {
      credentials,
      relay: {
        relayUrl: "https://relay.example.test",
        resolverToken: "resolver-secret",
        runtimeAccessTokenSigner,
        hostTunnelTokenSigner,
      },
      sandbox: { defaultDriver: "modal" },
      telemetry: { capture },
    })

    expect(services.projectionStore).toBe(base.projectionStore)
    expect(services.durableSessionLog).toBe(base.durableSessionLog)
    expect(services.credentials).toBe(credentials)
    expect(services.relay).toMatchObject({
      relayUrl: "https://relay.example.test",
      resolverToken: "resolver-secret",
    })
    expect(services.relay.runtimeAccessTokenSigner).toBe(runtimeAccessTokenSigner)
    expect(services.relay.hostTunnelTokenSigner).toBe(hostTunnelTokenSigner)
    expect(services.sandbox).toEqual({ defaultDriver: "modal" })
    services.telemetry.capture("user_1", "event")
    expect(capture).toHaveBeenCalledWith("user_1", "event")
  })

  test("accepts an explicit authority override regardless of env", () => {
    const previous = process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL
    delete process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL
    try {
      const fakeAuthority = { getWorkspace: vi.fn() } as never
      const services = createControlPlaneServices(fakePorts(), {
        authority: fakeAuthority,
      })
      expect(services.authority).toBe(fakeAuthority)
    } finally {
      if (previous) process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL = previous
    }
  })

  test("creates a hosted stack from explicit auth, store, credentials, relay, runtime host, and telemetry", () => {
    const sync = fakeSync()
    const options = hostedOptions()
    const services = createHostedControlPlaneServices(fakePorts(sync), options)

    expect(services.auth).toBe(options.auth)
    expect(services.credentials).toBe(options.credentials)
    expect(services.relay).toBe(options.relay)
    expect(services.sandbox).toBe(options.sandbox)
    expect(services.telemetry).toBe(options.telemetry)
    expect(services.localExecution).toEqual({ enabled: false })
    expect(services.authority).toBe(options.authority)
    expect(services.projectionStore.put_session_meta).toBe(sync.put_session_meta)
  })

  test("hosted stack rejects missing required hosted dependencies with clear errors", () => {
    for (const item of [
      {
        options: () => ({ ...hostedOptions(), auth: null as never }),
        message: "Hosted Control Plane requires signed auth",
      },
      {
        options: () => ({ ...hostedOptions(), authority: null as never }),
        message: "Hosted Control Plane requires workspace authority",
      },
      {
        options: () => ({ ...hostedOptions(), credentials: null as never }),
        message: "Hosted Control Plane requires shared credentials",
      },
      {
        options: () => ({ ...hostedOptions(), relay: { ...hostedOptions().relay, relayUrl: undefined } }),
        message: "Hosted Control Plane requires hosted relay URL",
      },
      {
        options: () => ({ ...hostedOptions(), relay: { ...hostedOptions().relay, resolverToken: undefined } }),
        message: "Hosted Control Plane requires Relay resolver token",
      },
      {
        options: () => ({ ...hostedOptions(), relay: { ...hostedOptions().relay, runtimeAccessTokenSigner: undefined } }),
        message: "Hosted Control Plane requires Runtime Access Token signer",
      },
      {
        options: () => ({ ...hostedOptions(), relay: { ...hostedOptions().relay, hostTunnelTokenSigner: undefined } }),
        message: "Hosted Control Plane requires Host Tunnel Token signer",
      },
      {
        options: () => ({ ...hostedOptions(), sandbox: { defaultDriver: undefined } }),
        message: "Hosted Control Plane requires sandbox driver",
      },
      {
        options: () => ({ ...hostedOptions(), telemetry: { capture: undefined as never } }),
        message: "Hosted Control Plane requires audit/telemetry capture",
      },
    ]) {
      expect(() => createHostedControlPlaneServices(fakePorts(), item.options())).toThrow(
        new ControlPlaneCompositionError("hosted_dependency_missing", item.message),
      )
    }
  })

  test("hosted stack rejects disabled auth and workspace-replicated session storage", () => {
    expect(() =>
      createHostedControlPlaneServices(fakePorts(), {
        ...hostedOptions(),
        auth: localOnlyAuthAdapter("signed auth disabled in test"),
      }),
    ).toThrow(new ControlPlaneCompositionError(
      "hosted_auth_disabled",
      "Hosted Control Plane requires enabled signed auth: signed auth disabled in test",
    ))

    expect(() =>
      createHostedControlPlaneServices({
        ...fakePorts(),
        sessionWriteMode: () => "workspace_replicated",
      }, hostedOptions()),
    ).toThrow(new ControlPlaneCompositionError(
      "hosted_sync_mode_invalid",
      "Hosted Control Plane requires central_canonical session storage",
    ))
  })

  test("explicit null override leaves authority unset regardless of env", () => {
    // The generic services never construct an authority; the composition site
    // injects it. `null` explicitly leaves it unset even when env is present.
    const previous = process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL
    process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL = "https://example.authority.test"
    try {
      const services = createControlPlaneServices(fakePorts(), {
        authority: null,
      })
      expect(services.authority).toBeUndefined()
    } finally {
      if (previous) process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL = previous
      else delete process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL
    }
  })

  test("authority is only present when injected, never derived from env", () => {
    const previous = process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL
    process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL = "https://ambient.authority.test"
    try {
      // Ambient env does not materialize an authority.
      expect(createControlPlaneServices(fakePorts()).authority).toBeUndefined()
      // Only an explicitly injected authority lands on the composed services.
      const injected = fakeAuthority()
      expect(createControlPlaneServices(fakePorts(), {
        authority: injected,
      }).authority).toBe(injected)
    } finally {
      if (previous) process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL = previous
      else delete process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL
    }
  })

  test("default behavior is preserved when no options are supplied", () => {
    const previous = process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL
    delete process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL
    try {
      const services = createControlPlaneServices(fakePorts())
      expect(services.authority).toBeUndefined()
    } finally {
      if (previous) process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL = previous
    }
  })
})
