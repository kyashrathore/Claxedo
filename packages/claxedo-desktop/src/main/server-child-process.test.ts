import { describe, expect, test } from "bun:test"

import { claxedoServerChildEnv, claxedoServerForkOptions } from "./server-child-process"

describe("Claxedo server daemon process", () => {
  const child = { port: 3210, dataDir: "/data", protocol: 4, token: "daemon-token", generation: "generation-1", build: "1.2.3", discoveryPath: "/data/daemon.json" }

  test("names the signed account's published key set, which signs the passes of the owner's connected machines", () => {
    const env = claxedoServerChildEnv({ ...child, controlPlaneOrigin: "https://core.example" })

    expect(env.CLAXEDO_CONTROL_PLANE_JWKS_URL).toBe("https://core.example/.well-known/jwks.json")
    expect([env.CLAXEDO_CHILD_PORT, env.CLAXEDO_DATA_DIR, env.CLAXEDO_DAEMON_PROTOCOL, env.CLAXEDO_DAEMON_TOKEN]).toEqual(["3210", "/data", "4", "daemon-token"])
  })

  test("without a configured account it names no key set, so the daemon serves no connected machine", () => {
    expect(claxedoServerChildEnv(child).CLAXEDO_CONTROL_PLANE_JWKS_URL).toBeUndefined()
  })

  test("runs detached from Electron while retaining startup IPC", () => {
    const env = {
      PATH: "/usr/bin",
      CLAXEDO_CHILD_PORT: "3210",
      ELECTRON_RUN_AS_NODE: "0",
    }

    expect(claxedoServerForkOptions(env, 7)).toEqual({
      execPath: process.execPath,
      execArgv: ["--expose-gc", "--optimize-for-size", "--max-old-space-size=512"],
      env: {
        PATH: "/usr/bin",
        CLAXEDO_CHILD_PORT: "3210",
        ELECTRON_RUN_AS_NODE: "1",
      },
      detached: true,
      stdio: ["ignore", 7, 7, "ipc"],
    })
    expect(env.ELECTRON_RUN_AS_NODE).toBe("0")
  })
})
