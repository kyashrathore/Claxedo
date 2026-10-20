import { describe, expect, test } from "bun:test"
import { PLATFORM_CALL_PERMISSIONS, type PluginCaller } from "@claxedo/plugin-api/backend"
import type { PluginPermission } from "@claxedo/plugin-api/manifest"
import type { PluginBackendActivation } from "./host-port"
import { admitPlatformCall } from "./platform-admission"

const person: PluginCaller = { orgId: "org_1", origin: "person", userId: "usr_1" }
const link: PluginCaller = { orgId: "org_1", origin: "link" }
const system: PluginCaller = { orgId: "org_1", origin: "system" }

function activation(permissions: readonly PluginPermission[] = []): PluginBackendActivation {
  return {
    epoch: 3,
    bundleHash: "a".repeat(64),
    manifest: {
      id: "counter",
      name: "Counter",
      version: "0.1.0",
      app: "./app.js",
      requires: [],
      server: { routes: [], operations: [] },
      permissions: [...permissions],
      backend: { entry: "./backend.js", objects: [], outbound: [], routes: ["GET /"] },
    },
  }
}

const EVERY_PERMISSION: PluginPermission[] = ["projects.read", "blobs", "events", "schedule", "links"]

/** One well-formed call of each name. */
const CALLS = {
  "identity.caller": { name: "identity.caller" },
  "projects.list": { name: "projects.list" },
  "projects.authorize": { name: "projects.authorize", projectId: "prj_1", access: "write" },
  "blobs.put": { name: "blobs.put", key: "a/b.txt", bytes: new Uint8Array([1]) },
  "blobs.get": { name: "blobs.get", key: "a/b.txt" },
  "blobs.head": { name: "blobs.head", key: "a/b.txt" },
  "blobs.delete": { name: "blobs.delete", key: "a/b.txt" },
  "blobs.list": { name: "blobs.list", prefix: "a/" },
  "events.publish": { name: "events.publish", audience: "org", topic: "changed" },
  "schedule.at": { name: "schedule.at", wake: "tick", at: 1 },
  "schedule.cancel": { name: "schedule.cancel", wake: "tick" },
  "schedule.list": { name: "schedule.list" },
  "links.create": { name: "links.create", path: "/count" },
  "links.revoke": { name: "links.revoke", token: "t" },
} as const

function code(answer: ReturnType<typeof admitPlatformCall>) {
  return answer.ok ? "admitted" : answer.code
}

describe("admitting a platform call", () => {
  test("refuses every call once its epoch is no longer the current activation, or when no backend is active", () => {
    for (const call of Object.values(CALLS)) {
      expect(code(admitPlatformCall({ raw: call, epoch: 2, activation: activation(EVERY_PERMISSION), caller: person })), call.name).toBe("plugin_backend_replaced")
      expect(code(admitPlatformCall({ raw: call, epoch: 3, activation: undefined, caller: person })), call.name).toBe("plugin_backend_replaced")
    }
  })

  test("refuses each call whose permission the manifest does not declare, and admits it once declared", () => {
    for (const call of Object.values(CALLS)) {
      const permission = PLATFORM_CALL_PERMISSIONS[call.name]
      const without = admitPlatformCall({ raw: call, epoch: 3, activation: activation(EVERY_PERMISSION.filter((entry) => entry !== permission)), caller: person })
      expect(code(without), call.name).toBe(permission ? "plugin_permission_not_declared" : "admitted")
      expect(code(admitPlatformCall({ raw: call, epoch: 3, activation: activation(EVERY_PERMISSION), caller: person })), call.name).toBe("admitted")
    }
  })

  test("a call that acts as a person needs a live handle for a person, and a link or a wake cannot make it", () => {
    for (const name of ["projects.list", "projects.authorize", "links.create"] as const) {
      expect(code(admitPlatformCall({ raw: CALLS[name], epoch: 3, activation: activation(EVERY_PERMISSION), caller: undefined })), name).toBe("plugin_caller_invalid")
      expect(code(admitPlatformCall({ raw: CALLS[name], epoch: 3, activation: activation(EVERY_PERMISSION), caller: link })), name).toBe("plugin_caller_not_a_person")
      expect(code(admitPlatformCall({ raw: CALLS[name], epoch: 3, activation: activation(EVERY_PERMISSION), caller: system })), name).toBe("plugin_caller_not_a_person")
    }
    const toCaller = { name: "events.publish", audience: "caller", topic: "changed" }
    expect(code(admitPlatformCall({ raw: toCaller, epoch: 3, activation: activation(EVERY_PERMISSION), caller: system }))).toBe("plugin_caller_not_a_person")
    expect(code(admitPlatformCall({ raw: CALLS["events.publish"], epoch: 3, activation: activation(EVERY_PERMISSION), caller: system }))).toBe("admitted")
    expect(code(admitPlatformCall({ raw: CALLS["identity.caller"], epoch: 3, activation: activation(), caller: undefined }))).toBe("plugin_caller_invalid")
    expect(code(admitPlatformCall({ raw: CALLS["identity.caller"], epoch: 3, activation: activation(), caller: link }))).toBe("admitted")
  })

  test("refuses a call whose fields the contract does not accept", () => {
    const invalid = [
      { name: "unknown.call" },
      { name: "blobs.get", key: "../escape" },
      { name: "blobs.get", key: "a//b" },
      { name: "blobs.put", key: "a", bytes: "not bytes" },
      { name: "events.publish", audience: "project", topic: "changed" },
      { name: "events.publish", audience: "org", projectId: "prj_1", topic: "changed" },
      { name: "links.create", path: "/_wake/tick" },
      { name: "links.create", path: "/count?x=1" },
      { name: "projects.authorize", projectId: "prj_1", access: "admin" },
      { name: "identity.caller", extra: true },
    ]
    for (const raw of invalid) {
      expect(code(admitPlatformCall({ raw, epoch: 3, activation: activation(EVERY_PERMISSION), caller: person })), JSON.stringify(raw)).toBe("plugin_call_invalid")
    }
  })
})
