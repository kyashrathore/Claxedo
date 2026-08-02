import { describe, expect, test } from "bun:test"
import { stripShellWrapper } from "./shell-wrapper"

/**
 * Harnesses execute shell tools through a login-shell wrapper (Codex: `/bin/zsh -lc …`).
 * That prefix is identical on every call, so the row must show the inner script or the
 * useful part of the command gets truncated off the end of the row.
 */
describe("stripShellWrapper", () => {
  test("strips /bin/zsh -lc with single quotes", () => {
    expect(stripShellWrapper(`/bin/zsh -lc 'rg --files docs'`)).toBe("rg --files docs")
  })

  test("strips /bin/zsh -lc with double quotes and keeps inner single quotes", () => {
    expect(stripShellWrapper(`/bin/zsh -lc "sed -n '1,240p' /Users/me/file.ts"`)).toBe(
      "sed -n '1,240p' /Users/me/file.ts",
    )
  })

  test("strips an unquoted script", () => {
    expect(stripShellWrapper("/bin/zsh -lc ls")).toBe("ls")
  })

  test("handles bash/sh and plain (non-absolute) shells", () => {
    expect(stripShellWrapper(`/bin/bash -lc 'bun test'`)).toBe("bun test")
    expect(stripShellWrapper(`sh -c "echo hi"`)).toBe("echo hi")
    expect(stripShellWrapper(`bash -c ls`)).toBe("ls")
  })

  test("leaves a bare command untouched", () => {
    expect(stripShellWrapper("bun test src/cloudflare.test.ts")).toBe("bun test src/cloudflare.test.ts")
    expect(stripShellWrapper("git diff --stat")).toBe("git diff --stat")
  })

  test("does not mangle commands that merely mention a shell", () => {
    expect(stripShellWrapper("echo /bin/zsh")).toBe("echo /bin/zsh")
    expect(stripShellWrapper("which bash")).toBe("which bash")
  })

  test("trims surrounding whitespace", () => {
    expect(stripShellWrapper("   /bin/zsh -lc '  ls -la  '   ")).toBe("ls -la")
  })
})
