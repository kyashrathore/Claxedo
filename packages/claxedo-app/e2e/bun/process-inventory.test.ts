import { describe, expect, test } from "bun:test"

import {
  descendantCommands,
  parsePosixProcessInventory,
  parseWindowsProcessInventory,
} from "../helpers/process-inventory"

describe("process inventory", () => {
  test("parses the portable POSIX process table", () => {
    expect(parsePosixProcessInventory(`
      10     1 /Applications/Claxedo.app/Contents/MacOS/Claxedo --flag
      11    10 /Applications/Claxedo.app/Contents/Frameworks/Claxedo Helper
    `)).toEqual([
      { pid: 10, ppid: 1, command: "/Applications/Claxedo.app/Contents/MacOS/Claxedo --flag" },
      { pid: 11, ppid: 10, command: "/Applications/Claxedo.app/Contents/Frameworks/Claxedo Helper" },
    ])
  })

  test("parses the Win32_Process CIM inventory for one or many rows", () => {
    expect(parseWindowsProcessInventory(JSON.stringify({
      ProcessId: 20,
      ParentProcessId: 2,
      CommandLine: "C:\\Claxedo\\Claxedo.exe --flag",
    }))).toEqual([{ pid: 20, ppid: 2, command: "C:\\Claxedo\\Claxedo.exe --flag" }])

    expect(parseWindowsProcessInventory(JSON.stringify([
      { ProcessId: 20, ParentProcessId: 2, CommandLine: "C:\\Claxedo\\Claxedo.exe --flag" },
      { ProcessId: 21, ParentProcessId: 20, CommandLine: "C:\\Claxedo\\resources\\host-connector\\index.js" },
    ]))).toHaveLength(2)
  })

  test("returns the complete transitive descendant command trace", () => {
    expect(descendantCommands(30, [
      { pid: 30, ppid: 1, command: "Claxedo" },
      { pid: 31, ppid: 30, command: "Claxedo Helper" },
      { pid: 32, ppid: 31, command: "host-connector/index.js" },
      { pid: 40, ppid: 1, command: "unrelated" },
    ])).toEqual(["Claxedo", "Claxedo Helper", "host-connector/index.js"])
  })

  test("rejects an incomplete owned-process observation instead of silently passing", () => {
    expect(() => descendantCommands(50, [
      { pid: 50, ppid: 1, command: "Claxedo" },
      { pid: 51, ppid: 50, command: "" },
    ])).toThrow("process 51 had no observable command line")
    expect(() => descendantCommands(99, [
      { pid: 50, ppid: 1, command: "Claxedo" },
    ])).toThrow("process inventory did not contain root 99")
  })
})
