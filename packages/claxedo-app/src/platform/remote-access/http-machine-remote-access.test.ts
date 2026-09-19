import { describe, expect, test } from "bun:test"
import { httpMachineRemoteAccess } from "./http-machine-remote-access"

/**
 * The self-hosted Node product's half of the port.
 *
 * `deployments/self-hosted-node/app.ts` still mounts `RemoteAccessRoutes` at
 * `/api/claxedo/remote-access`, so this implementation must keep reaching those
 * exact paths and verbs. The funnel assertions went with the events, to the
 * controller that now owns them.
 */
function scripted(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ path: string; method: string; body?: string }> = []
  return {
    calls,
    request: async (path: string, init?: RequestInit) => {
      calls.push({ path, method: init?.method ?? "GET", ...(typeof init?.body === "string" ? { body: init.body } : {}) })
      const next = responses.shift()
      if (!next) throw new Error("missing scripted response")
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { "content-type": "application/json" },
      })
    },
  }
}

describe("http machine remote access", () => {
  test("loads honest capability state, enables one machine, and lists devices", async () => {
    const script = scripted([
      { status: 200, body: { device_login_configured: false, relay_configured: false, hosted_signed_in: false, enabled: false } },
      { status: 200, body: { host_id: "host_1", workspace_ids: ["ws_1", "ws_2"], connection_count: 1 } },
      { status: 200, body: { devices: [{ host_id: "host_1", display_name: "Yash's Mac", last_seen_at: 10, workspace_ids: ["ws_1", "ws_2"] }] } },
    ])
    const port = httpMachineRemoteAccess({ request: script.request })

    await expect(port.status()).resolves.toEqual({
      deviceLoginConfigured: false,
      relayConfigured: false,
      hostedSignedIn: false,
      enrolled: false,
      enabled: false,
      secondDeviceOpen: false,
    })
    await port.enable({ startAtLogin: true })
    await expect(port.devices?.()).resolves.toEqual([{
      hostId: "host_1",
      displayName: "Yash's Mac",
      lastSeenAt: 10,
      workspaceIds: ["ws_1", "ws_2"],
    }])
    // The regression's other side: a self-hosted server DOES serve these, so
    // the same Enable button must still produce exactly this request.
    expect(script.calls).toEqual([
      { path: "/api/claxedo/remote-access", method: "GET" },
      // No name on the wire: the machine this server runs on derives its own,
      // and a browser asked for one can only describe the browser.
      { path: "/api/claxedo/remote-access/enable", method: "POST", body: JSON.stringify({ start_at_login: true }) },
      { path: "/api/claxedo/remote-access/devices", method: "GET" },
    ])
  })

  test("renames a machine and reports the name the control plane kept", async () => {
    const script = scripted([
      { status: 200, body: { display_name: "Build box" } },
      { status: 404, body: { error: { code: "host_enrollment_not_found", message: "That machine is not enrolled" } } },
    ])
    const port = httpMachineRemoteAccess({ request: script.request })

    await expect(port.rename?.({ hostId: "host_1", displayName: "  Build box  " })).resolves.toEqual({ displayName: "Build box" })
    await expect(port.rename?.({ hostId: "host_x", displayName: "Build box" })).rejects.toThrow("That machine is not enrolled")
    expect(script.calls).toEqual([
      { path: "/api/claxedo/remote-access/devices/host_1", method: "PATCH", body: JSON.stringify({ display_name: "  Build box  " }) },
      { path: "/api/claxedo/remote-access/devices/host_x", method: "PATCH", body: JSON.stringify({ display_name: "Build box" }) },
    ])
  })

  test("records second-device completion, reporting what the server decided", async () => {
    const script = scripted([
      { status: 200, body: { recorded: false } },
      { status: 200, body: { recorded: true } },
    ])
    const port = httpMachineRemoteAccess({ request: script.request })

    await expect(port.markSecondDeviceOpen?.({ workspaceId: "ws_1", sourceClientId: "desktop", currentClientId: "desktop" }))
      .resolves.toEqual({ recorded: false })
    await expect(port.markSecondDeviceOpen?.({ workspaceId: "ws_1", sourceClientId: "desktop", currentClientId: "phone" }))
      .resolves.toEqual({ recorded: true })
    expect(script.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /api/claxedo/remote-access/workspaces/ws_1/second-device-open",
      "POST /api/claxedo/remote-access/workspaces/ws_1/second-device-open",
    ])
  })

  test("revokes a machine and surfaces blocker errors", async () => {
    const script = scripted([
      { status: 501, body: { error: { code: "remote_access_unavailable", message: "Device sign-in is not configured" } } },
      { status: 200, body: { revoked: true } },
    ])
    const port = httpMachineRemoteAccess({ request: script.request })

    await expect(port.enable({ startAtLogin: false })).rejects.toThrow("Device sign-in is not configured")
    await expect(port.revoke("host/1")).resolves.toEqual({ revoked: true })
    expect(script.calls[1]).toEqual({
      path: "/api/claxedo/remote-access/devices/host%2F1",
      method: "DELETE",
    })
  })

  test("rejects a 200 that enrolled nothing", async () => {
    // `enable` returns nothing, so the only way it can report failure is by
    // rejecting. A server answering 200 with an empty body must not read as a
    // published machine.
    const script = scripted([{ status: 200, body: {} }])
    const port = httpMachineRemoteAccess({ request: script.request })

    await expect(port.enable({ startAtLogin: false })).rejects.toThrow("host_id")
  })

  test("offers the two capabilities the HTTP product has, and no pause", async () => {
    // Shape, not behaviour: `pause` exists only where a connector can stop its
    // own heartbeat. There is no pause route, and binding a stub would make
    // "this product cannot pause" look like "pausing did nothing".
    const port = httpMachineRemoteAccess({ request: async () => new Response("{}") })

    expect(typeof port.devices).toBe("function")
    expect(typeof port.markSecondDeviceOpen).toBe("function")
    expect(typeof port.providerConfig?.rows).toBe("function")
    expect(typeof port.providerConfig?.push).toBe("function")
    expect(port.pause).toBeUndefined()
    expect(port.subscribe).toBeUndefined()
  })

  test("reads each machine's provider-configuration standing off the owner's enrollment list", async () => {
    const script = scripted([
      {
        status: 200,
        body: {
          active: null,
          machines: [
            {
              enrollment_id: "enr_1",
              host_id: "host_1",
              display_name: "Build box",
              provider_config_revision: 3,
              provider_config_acked_revision: 2,
              sealing_key_declared: true,
              provider_config_providers: ["openai", 7],
              provider_config_rekeyed: true,
            },
            {
              enrollment_id: "enr_2",
              host_id: "host_2",
              provider_config_revision: 0,
              provider_config_acked_revision: 0,
              sealing_key_declared: false,
            },
          ],
        },
      },
      { status: 200, body: { active: null } },
      { status: 200, body: { active: null, machines: [{ enrollment_id: "enr_3", host_id: "host_3" }] } },
    ])
    const port = httpMachineRemoteAccess({ request: script.request })

    await expect(port.providerConfig?.rows()).resolves.toEqual([
      // A non-string in the id list is dropped rather than shown as a provider name.
      {
        enrollmentId: "enr_1",
        hostId: "host_1",
        revision: 3,
        ackedRevision: 2,
        sealingKeyDeclared: true,
        providers: ["openai"],
        rekeyed: true,
      },
      {
        enrollmentId: "enr_2",
        hostId: "host_2",
        revision: 0,
        ackedRevision: 0,
        sealingKeyDeclared: false,
        providers: [],
        rekeyed: false,
      },
    ])
    // A control plane without an enrollment-listing authority answers the
    // active row alone; that is no machines, not a broken list.
    await expect(port.providerConfig?.rows()).resolves.toEqual([])
    // A row missing its revision is a server this client does not understand,
    // named by field, never a machine that silently reads as "nothing pushed".
    await expect(port.providerConfig?.rows()).rejects.toThrow("machines[0].provider_config_revision")
    expect(script.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /api/claxedo/host/enrollments",
      "GET /api/claxedo/host/enrollments",
      "GET /api/claxedo/host/enrollments",
    ])
  })

  test("pushes one machine's providers as the runtime's own row shape, and an empty map withdraws them", async () => {
    const script = scripted([
      { status: 200, body: { enrollment_id: "enr/1", revision: 4, sealed: true } },
      { status: 200, body: { enrollment_id: "enr/1", revision: 5, sealed: false } },
      {
        status: 409,
        body: {
          error: {
            code: "host_sealing_key_undeclared",
            message: "The machine has not declared a sealing key; it declares one on its next heartbeat",
          },
        },
      },
    ])
    const port = httpMachineRemoteAccess({ request: script.request })
    const providers = {
      anthropic: { baseUrl: "https://api.anthropic.com", placeholder: "sk-ant-secret", authMode: "api-key" as const, apiPath: "/v1" },
    }

    await expect(port.providerConfig?.push({ enrollmentId: "enr/1", providers })).resolves.toEqual({ revision: 4, sealed: true })
    await expect(port.providerConfig?.push({ enrollmentId: "enr/1", providers: {} })).resolves.toEqual({ revision: 5, sealed: false })
    await expect(port.providerConfig?.push({ enrollmentId: "enr_2", providers })).rejects.toThrow("has not declared a sealing key")
    expect(script.calls).toEqual([
      {
        path: "/api/claxedo/host/enrollments/enr%2F1/provider-config",
        method: "POST",
        body: JSON.stringify({ providers }),
      },
      { path: "/api/claxedo/host/enrollments/enr%2F1/provider-config", method: "POST", body: JSON.stringify({ providers: {} }) },
      { path: "/api/claxedo/host/enrollments/enr_2/provider-config", method: "POST", body: JSON.stringify({ providers }) },
    ])
  })
})
