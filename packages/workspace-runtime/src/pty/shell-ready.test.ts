import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { SHELL_READY_MARKER } from "./shell-ready"

/**
 * The marker literal is duplicated into shell scripts that cannot import it.
 * These assertions are the drift guard: rename the constant without updating an
 * emitter and the corresponding case fails, instead of shell-readiness silently
 * degrading to the 1200ms fallback timer.
 */
const HOOKS = path.join(import.meta.dir, "..", "agent-hooks")

function read(relative: string) {
  return fs.readFileSync(path.join(HOOKS, relative), "utf8")
}

describe("shell-ready marker emitters", () => {
  test("zsh login template emits the marker", () => {
    expect(read("templates/zshlogin.template.sh")).toContain(SHELL_READY_MARKER)
  })

  test("bashrc template emits the marker", () => {
    expect(read("templates/bashrc.template.sh")).toContain(SHELL_READY_MARKER)
  })

  test("fish inline hook emits the marker", () => {
    expect(read("core/shell.ts")).toContain(SHELL_READY_MARKER)
  })

  test("every emitter uses OSC 777", () => {
    expect(read("templates/zshlogin.template.sh")).toContain("777;")
    expect(read("templates/bashrc.template.sh")).toContain("777;")
    expect(read("core/shell.ts")).toContain("777;")
  })
})
