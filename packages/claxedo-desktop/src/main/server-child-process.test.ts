import { describe, expect, test } from "bun:test"

import { claxedoServerForkOptions } from "./server-child-process"

describe("Claxedo server daemon process", () => {
  test("runs detached from Electron while retaining startup IPC", () => {
    const env = {
      PATH: "/usr/bin",
      CLAXEDO_CHILD_PORT: "3210",
      ELECTRON_RUN_AS_NODE: "0",
    }

    expect(claxedoServerForkOptions(env)).toEqual({
      execPath: process.execPath,
      execArgv: ["--expose-gc", "--optimize-for-size", "--max-old-space-size=512"],
      env: {
        PATH: "/usr/bin",
        CLAXEDO_CHILD_PORT: "3210",
        ELECTRON_RUN_AS_NODE: "1",
      },
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    })
    expect(env.ELECTRON_RUN_AS_NODE).toBe("0")
  })
})
