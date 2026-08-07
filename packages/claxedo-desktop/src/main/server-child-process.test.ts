import { describe, expect, test } from "bun:test"

import { claxedoServerForkOptions } from "./server-child-process"

describe("Claxedo server child process", () => {
  test("runs the Electron executable as Node with inherited stdio and a dedicated IPC channel", () => {
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
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    })
    expect(env.ELECTRON_RUN_AS_NODE).toBe("0")
  })
})
