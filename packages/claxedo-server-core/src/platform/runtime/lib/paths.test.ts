import { afterEach, describe, expect, test } from "vitest"
import os from "os"
import path from "path"
import { dataDir, stateDir } from "./paths"

const prev = { data: process.env.CLAXEDO_DATA_DIR, state: process.env.CLAXEDO_STATE_DIR }

function set(key: "CLAXEDO_DATA_DIR" | "CLAXEDO_STATE_DIR", value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  set("CLAXEDO_DATA_DIR", prev.data)
  set("CLAXEDO_STATE_DIR", prev.state)
})

describe("dataDir", () => {
  test("an unset variable falls back to the home directory", () => {
    set("CLAXEDO_DATA_DIR", undefined)
    expect(dataDir()).toBe(path.join(os.homedir(), ".claxedo"))
  })

  test("the empty value shipped in .env.example falls back too", () => {
    set("CLAXEDO_DATA_DIR", "   ")
    expect(dataDir()).toBe(path.join(os.homedir(), ".claxedo"))
  })

  test("an absolute directory is used as given", () => {
    const dir = path.join(os.tmpdir(), "claxedo-paths-test")
    set("CLAXEDO_DATA_DIR", dir)
    expect(dataDir()).toBe(dir)
  })

  test("the sqlite in-memory sentinel survives the absolute-path check", () => {
    set("CLAXEDO_DATA_DIR", ":memory:")
    expect(dataDir()).toBe(":memory:")
  })

  // The shape left by `process.env.CLAXEDO_DATA_DIR = saved` when `saved` is
  // undefined. Resolving it would put a database under the process cwd.
  test("the string an assignment-restore leaves behind is refused", () => {
    set("CLAXEDO_DATA_DIR", "undefined")
    expect(() => dataDir()).toThrow('CLAXEDO_DATA_DIR must be an absolute path, received "undefined"')
  })
})

describe("stateDir", () => {
  test("an unset variable nests under the data directory", () => {
    const dir = path.join(os.tmpdir(), "claxedo-paths-test")
    set("CLAXEDO_DATA_DIR", dir)
    set("CLAXEDO_STATE_DIR", undefined)
    expect(stateDir()).toBe(path.join(dir, "state"))
  })

  test("a relative value is refused rather than resolved against the cwd", () => {
    set("CLAXEDO_STATE_DIR", "undefined")
    expect(() => stateDir()).toThrow("CLAXEDO_STATE_DIR")
  })
})
