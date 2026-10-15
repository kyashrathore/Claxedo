import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { describe, expect, test } from "vitest"
import type { RelayHostAuthContext } from "@claxedo/session-core/relay-host"
import type { WorkspaceRuntimeRouteContext } from "@claxedo/workspace-runtime/route-contribution"
import { RUNTIME_LEASE_ENV_PATH } from "@claxedo/server-core/hosts/workspace-runtime/env"
import { configureRuntimeGitAuth } from "./git-auth"
import { runtimeLeaseEnv } from "./lease-env"

const CONTROL_PLANE_CALLER = { principal_kind: "service", actor_id: "control-plane" }

// The runtime runs only inside the Linux sandbox image, so its git has no Windows host.
describe.skipIf(process.platform === "win32")("a serving runtime's lease env", () => {
  const rig = async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "lease-env-test-"))
    const bootEnv = {
      PATH: process.env.PATH,
      HOME: directory,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(directory, "gitconfig"),
      WORKSPACE_RUNTIME_GIT_REPO_URL: "https://github.com/acme/private.git",
      CLAXEDO_GITHUB_CLONE_AUTH: "Bearer boot-pass",
      CLAXEDO_GITHUB_CLONE_BROKER_URL: "https://api.claxedo.test/bindings/b1",
    }
    await configureRuntimeGitAuth(bootEnv)
    const deliver = (body: unknown, caller: object = CONTROL_PLANE_CALLER) => {
      const relay = new Hono<{ Variables: RelayHostAuthContext }>()
      relay.use("*", async (c, next) => {
        c.set("relayHostAuth", caller as RelayHostAuthContext["relayHostAuth"])
        await next()
      })
      relay.route("/", runtimeLeaseEnv(bootEnv).mount({} as WorkspaceRuntimeRouteContext).routes)
      return relay.request(RUNTIME_LEASE_ENV_PATH, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    }
    const config = () => execFileSync("git", ["config", "--global", "--list"], { env: bootEnv, encoding: "utf8" }).trim().split("\n").filter(Boolean).sort()
    return { directory, deliver, config }
  }
  const brokered = "https://api.claxedo.test/bindings/b1/acme/private.git"

  test("a renewed placeholder replaces the boot's, only from the control plane, and an empty delivery withdraws it", async () => {
    const { directory, deliver, config } = await rig()
    try {
      expect((await deliver({ CLAXEDO_GITHUB_CLONE_AUTH: "Bearer stolen" }, { principal_kind: "user", actor_id: "act_reader" })).status).toBe(403)
      expect(config()).toContain(`http.${brokered}.extraheader=Authorization: Bearer boot-pass`)

      const renewed = await deliver({ CLAXEDO_GITHUB_CLONE_AUTH: "Bearer renewed-pass", CLAXEDO_GITHUB_CLONE_BROKER_URL: "https://api.claxedo.test/bindings/b1" })
      expect(renewed.status).toBe(204)
      expect(config()).toEqual([
        `http.${brokered}.extraheader=Authorization: Bearer renewed-pass`,
        `url.${brokered}.insteadof=https://github.com/acme/private.git`,
      ])

      expect((await deliver({ CLAXEDO_GITHUB_CLONE_AUTH: 7 })).status).toBe(400)
      expect((await deliver({ CLAXEDO_GITHUB_CLONE_AUTH: "Bearer x\r\nX-Injected: 1" })).status).toBe(400)
      expect(config()).toContain(`http.${brokered}.extraheader=Authorization: Bearer renewed-pass`)

      expect((await deliver({})).status).toBe(204)
      expect(config()).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
