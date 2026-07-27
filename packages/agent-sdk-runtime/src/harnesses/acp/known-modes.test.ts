import { describe, expect, test } from "bun:test"
import { createRequire } from "node:module"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { ACP_KNOWN_MODES, ACP_KNOWN_MODE_VERSIONS, draftPermissionModes } from "./session"

const require_ = createRequire(import.meta.url)

/**
 * `ACP_KNOWN_MODES` is a copy of somebody else's data, so the only interesting
 * question about it is whether the copy is still current. These tests answer
 * that two ways: the version pin catches an agent upgrade, and the shape rules
 * catch a hand-edit that reintroduces a Claxedo-invented option.
 */
describe("ACP known modes", () => {
  const staleMessage = (harness: string, name: string, installed: string, pinned: string) =>
    `${name} is ${installed}, but ${harness}'s modes were recorded from ${pinned}. ` +
    `Re-run \`bun run script/permission-probe.ts\` and paste its liveModesFull into ACP_KNOWN_MODES, ` +
    `then bump ACP_KNOWN_MODE_VERSIONS. Do NOT just bump the version: the whole point of the pin is ` +
    `that a new agent build may have added, removed, or renamed a mode, and a draft that shows the ` +
    `old list is showing a permission the running agent does not have.`

  test("the pinned npm-shipped agents are the versions we recorded", () => {
    for (const [harness, pin] of Object.entries(ACP_KNOWN_MODE_VERSIONS)) {
      if (pin.source !== "npm") continue
      const meta = require_(`${pin.package}/package.json`) as { version: string }
      expect(meta.version, staleMessage(harness, pin.package, meta.version, pin.version)).toBe(pin.version)
    }
  })

  /**
   * PATH-installed agents can only be checked where they are installed. A CI box
   * without Cursor must not fail on a version it cannot observe, so this skips —
   * and says so — rather than passing silently, which would read as a check that
   * ran.
   */
  test("the pinned PATH-installed agents are the versions we recorded, where present", () => {
    for (const [harness, pin] of Object.entries(ACP_KNOWN_MODE_VERSIONS)) {
      if (pin.source !== "path") continue
      const found = (process.env.PATH ?? "")
        .split(path.delimiter)
        .map((dir) => path.join(dir, pin.command))
        .find((candidate) => fs.existsSync(candidate))
      if (!found) {
        console.log(`  skipped: ${pin.command} is not on PATH, so ${harness}'s pin cannot be checked here`)
        continue
      }
      const installed = execFileSync(found, ["--version"], { encoding: "utf8" }).trim()
      expect(installed, staleMessage(harness, pin.command, installed, pin.version)).toBe(pin.version)
    }
  })

  test("every pinned harness has a table, and every table is pinned", () => {
    expect(Object.keys(ACP_KNOWN_MODES).sort()).toEqual(Object.keys(ACP_KNOWN_MODE_VERSIONS).sort())
  })

  /**
   * Guards against Claxedo's old vocabulary being pasted back into a table that
   * is supposed to be a verbatim copy.
   *
   * This checks NAMES, not ids. Banning the rung ids was the obvious first
   * instinct and it is wrong: `cursor-agent acp` genuinely advertises a mode
   * whose id is `ask`, and claude-agent-acp one whose id is `auto`, so an
   * id-based rule forbids recording real agent data. The invented names never
   * came from any agent, which makes them the safe thing to assert on.
   */
  test("no table reintroduces a Claxedo-invented rung name", () => {
    const invented = ["Ask for everything", "Allow everything except danger", "Allow everything"]
    for (const [harness, modes] of Object.entries(ACP_KNOWN_MODES)) {
      const found = modes!.filter((mode) => invented.includes(mode.name))
      expect(found.map((mode) => mode.name), `${harness} names a Claxedo rung, not an agent mode`).toEqual([])
    }
  })

  test("a harness with no recorded table reports nothing rather than a guess", () => {
    const unrecorded = (["claude", "codex", "cursor"] as const).filter((id) => !ACP_KNOWN_MODES[id])
    for (const harness of unrecorded) {
      expect(draftPermissionModes(harness)).toEqual({ modes: [], appliesFrom: "next-turn" })
    }
  })

  test("drafts carry the levels the live list would derive", () => {
    // Same `LEVEL_IDS` pass as `permissionModes`, so a draft and a session agree
    // about which row Auto points at. If these drifted, Auto would jump to a
    // different mode the moment the session started.
    expect(draftPermissionModes("claude").modes.find((mode) => mode.level === "auto")?.id).toBe("auto")
    expect(draftPermissionModes("codex").modes.find((mode) => mode.level === "auto")?.id).toBe("agent")
    expect(draftPermissionModes("codex").modes.find((mode) => mode.level === "full")?.id).toBe("agent-full-access")
    expect(draftPermissionModes("codex").modes.find((mode) => mode.level === "ask")?.id).toBe("read-only")
    expect(draftPermissionModes("cursor").modes.find((mode) => mode.level === "auto")?.id).toBe("agent")
    expect(draftPermissionModes("cursor").modes.find((mode) => mode.level === "ask")?.id).toBe("ask")
  })

  test("exactly one auto rung per harness, because Auto resolves by finding one", () => {
    for (const [harness, modes] of Object.entries(ACP_KNOWN_MODES)) {
      expect(modes!.filter((mode) => mode.level === "auto").length, harness).toBe(1)
    }
  })
})
