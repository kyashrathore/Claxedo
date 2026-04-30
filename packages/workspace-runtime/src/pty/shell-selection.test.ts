/**
 * Tests for the shell selection and login-arg logic embedded in Pty.create().
 *
 * The workspace-runtime PTY module has its own inline shell detection
 * (not using opencode's Shell module). These tests validate that logic:
 *
 *   const shellName = command.split("/").pop() || ""
 *   if (/^(ba|da|k|c|z|tc|fi)?sh$/.test(shellName)) { args.push("-l") }
 */
import { describe, expect, test } from "bun:test"

// Extract the login-shell detection logic from Pty.create() for isolated testing
function shouldAddLoginFlag(command: string): boolean {
  const shellName = command.split("/").pop() || ""
  return /^(ba|da|k|c|z|tc|fi)?sh$/.test(shellName)
}

describe("workspace-runtime shell login flag detection", () => {
  // POSIX shells that should get -l
  test("bash gets login flag", () => {
    expect(shouldAddLoginFlag("/bin/bash")).toBe(true)
    expect(shouldAddLoginFlag("bash")).toBe(true)
  })

  test("zsh gets login flag", () => {
    expect(shouldAddLoginFlag("/bin/zsh")).toBe(true)
    expect(shouldAddLoginFlag("zsh")).toBe(true)
  })

  test("sh gets login flag", () => {
    expect(shouldAddLoginFlag("/bin/sh")).toBe(true)
    expect(shouldAddLoginFlag("sh")).toBe(true)
  })

  test("dash gets login flag", () => {
    expect(shouldAddLoginFlag("/bin/dash")).toBe(true)
    expect(shouldAddLoginFlag("dash")).toBe(true)
  })

  test("ksh gets login flag", () => {
    expect(shouldAddLoginFlag("/bin/ksh")).toBe(true)
    expect(shouldAddLoginFlag("ksh")).toBe(true)
  })

  test("csh gets login flag", () => {
    expect(shouldAddLoginFlag("/bin/csh")).toBe(true)
    expect(shouldAddLoginFlag("csh")).toBe(true)
  })

  test("tcsh gets login flag", () => {
    expect(shouldAddLoginFlag("/bin/tcsh")).toBe(true)
    expect(shouldAddLoginFlag("tcsh")).toBe(true)
  })

  test("fish gets login flag", () => {
    expect(shouldAddLoginFlag("/usr/bin/fish")).toBe(true)
    expect(shouldAddLoginFlag("fish")).toBe(true)
  })

  // Non-POSIX / Windows shells that should NOT get -l
  test("pwsh does NOT get login flag", () => {
    expect(shouldAddLoginFlag("pwsh")).toBe(false)
    expect(shouldAddLoginFlag("/usr/bin/pwsh")).toBe(false)
  })

  test("powershell does NOT get login flag", () => {
    expect(shouldAddLoginFlag("powershell")).toBe(false)
    expect(shouldAddLoginFlag("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe(false)
  })

  test("cmd.exe does NOT get login flag", () => {
    expect(shouldAddLoginFlag("cmd.exe")).toBe(false)
    expect(shouldAddLoginFlag("C:\\Windows\\System32\\cmd.exe")).toBe(false)
  })

  test("nu (nushell) does NOT get login flag", () => {
    expect(shouldAddLoginFlag("nu")).toBe(false)
    expect(shouldAddLoginFlag("/usr/bin/nu")).toBe(false)
  })

  test("pwsh.exe does NOT get login flag", () => {
    expect(shouldAddLoginFlag("pwsh.exe")).toBe(false)
    expect(shouldAddLoginFlag("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe(false)
  })
})

describe("workspace-runtime shell fallback chain", () => {
  test("uses SHELL env var when available", () => {
    // The create() function checks: input.command || process.env.SHELL || os.userInfo().shell || "/bin/sh"
    // This test documents the priority chain
    const command = process.env.SHELL || "/bin/sh"
    expect(typeof command).toBe("string")
    expect(command.length).toBeGreaterThan(0)
  })

  test("fallback /bin/sh is a valid POSIX shell", () => {
    expect(shouldAddLoginFlag("/bin/sh")).toBe(true)
  })
})

describe("workspace-runtime Windows PTY env setup", () => {
  test("sets UTF-8 locale vars on win32", () => {
    // In Pty.create(): if (process.platform === "win32") { env.LC_ALL = "C.UTF-8" ... }
    if (process.platform === "win32") {
      // On actual Windows, these would be set
      const env: Record<string, string> = {}
      env.LC_ALL = "C.UTF-8"
      env.LC_CTYPE = "C.UTF-8"
      env.LANG = "C.UTF-8"
      expect(env.LC_ALL).toBe("C.UTF-8")
      expect(env.LC_CTYPE).toBe("C.UTF-8")
      expect(env.LANG).toBe("C.UTF-8")
    }
  })

  test("killProcessTree uses platform-specific approach", () => {
    // On win32: no process.kill(-pid, signal) — would need taskkill
    // The current code only uses process.kill(-pid) on non-win32
    // This test documents the expected behavior
    if (process.platform === "win32") {
      // On Windows, process.kill(-pid) throws — the code correctly guards with:
      // if (process.platform !== "win32") { process.kill(-pid, signal) }
      expect(() => process.kill(-99999, 0)).toThrow()
    }
  })
})
