import { describe, expect, test } from "vitest"
import { createWorkspaceHost } from "../workspace"
import { createWorkspaceRuntimeApp } from "../server"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"

describe("workspace checkpoint routes", () => {
  test("freeze fences writes until resume", async () => {
    const runtime = createWorkspaceRuntimeApp({ exposure: loopbackWorkspaceRuntimeExposure() })

    expect((await runtime.app.request("/api/wr/checkpoint/freeze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ policy: "drain" }),
    })).status).toBe(200)
    expect((await runtime.app.request("/api/wr/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })).status).toBe(423)
    expect((await runtime.app.request("/api/wr/checkpoint/resume", { method: "POST" })).status).toBe(200)
    expect((await runtime.app.request("/api/wr/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })).status).not.toBe(423)

    runtime.dispose()
  })

  test("freeze waits for admitted writes and then reaches a stable frozen state", async () => {
    const host = createWorkspaceHost()
    const release = host.checkpoint.beginWrite()
    if (!release) throw new Error("write unexpectedly fenced")
    let resolved = false
    const frozen = host.checkpoint.freeze("drain").then((value) => {
      resolved = true
      return value
    })

    await Promise.resolve()
    expect(host.checkpoint.detail()).toMatchObject({ state: "freezing", activeWrites: 1 })
    expect(resolved).toBe(false)
    release()
    await expect(frozen).resolves.toMatchObject({ state: "frozen", activeWrites: 0 })

    host.dispose()
  })

  test("flush and restore reconciliation require the checkpoint protocol", async () => {
    const runtime = createWorkspaceRuntimeApp({ exposure: loopbackWorkspaceRuntimeExposure() })

    expect((await runtime.app.request("/api/wr/checkpoint/flush", { method: "POST" })).status).toBe(409)
    expect((await runtime.app.request("/api/wr/checkpoint/restore-reconcile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ epoch: 0, checkpointId: "" }),
    })).status).toBe(400)

    runtime.dispose()
  })
})
