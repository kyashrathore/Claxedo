import { afterEach, describe, expect, test } from "bun:test"
import { createRequire } from "node:module"
import {
  ACP_KNOWN_MODES,
  ACP_KNOWN_MODE_VERSIONS,
  draftPermissionModes,
  forgetLiveModes,
  rememberLiveModes,
} from "./session"

const require_ = createRequire(import.meta.url)

/**
 * `ACP_KNOWN_MODES` is a copy of somebody else's data, so the only interesting
 * question about it is whether the copy is still current. These tests answer
 * that two ways: the version pin catches an agent upgrade, and the shape rules
 * catch a hand-edit that reintroduces a Claxedo-invented option.
 */
describe("ACP known modes", () => {
  // The learned map is process-global, so a test that populates it would
  // otherwise change what every later test sees.
  afterEach(forgetLiveModes)

  const staleMessage = (harness: string, name: string, installed: string, pinned: string) =>
    `${name} is ${installed}, but ${harness}'s modes were recorded from ${pinned}. ` +
    `Re-run \`bun run script/permission-probe.ts\` and paste its liveModesFull into ACP_KNOWN_MODES, ` +
    `then bump ACP_KNOWN_MODE_VERSIONS. Do NOT just bump the version: the whole point of the pin is ` +
    `that a new agent build may have added, removed, or renamed a mode, and a draft that shows the ` +
    `old list is showing a permission the running agent does not have.`

  test("the agents this package ships are the versions we recorded", () => {
    for (const [harness, pin] of Object.entries(ACP_KNOWN_MODE_VERSIONS)) {
      const meta = require_(`${pin.package}/package.json`) as { version: string }
      expect(meta.version, staleMessage(harness, pin.package, meta.version, pin.version)).toBe(pin.version)
    }
  })

  /**
   * Only agents shipped as dependencies can be pinned, because only those
   * resolve to the same build for everyone. `cursor-agent` is user-installed and
   * self-updating, so pinning it would assert the developer's laptop and fail on
   * everybody else's; `rememberLiveModes` covers it instead.
   */
  test("every pinned harness is one this package ships", () => {
    const shipped = ["claude", "codex"]
    expect(Object.keys(ACP_KNOWN_MODE_VERSIONS).sort()).toEqual(shipped)
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

  /**
   * All three ACP harnesses currently have a seed, so this drives the fallback
   * with a synthetic id rather than looping over the real ones and asserting
   * nothing. The branch is what a fourth ACP harness would land in before anyone
   * probes it, and it must show an empty list rather than borrow another
   * agent's.
   */
  test("a harness with no recorded table reports nothing rather than a guess", () => {
    const unprobed = "some-future-acp-agent" as unknown as keyof typeof ACP_KNOWN_MODES
    expect(ACP_KNOWN_MODES[unprobed]).toBeUndefined()
    expect(draftPermissionModes(unprobed)).toEqual({ modes: [], appliesFrom: "next-turn" })
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

  /**
   * The seed is a guess about the user's build; their own agent is fact. These
   * cover the handover, which is what makes an unpinnable agent like Cursor safe
   * to seed at all.
   */
  describe("learning from the user's own agent", () => {
    const live = { modes: [{ id: "invented-by-a-newer-build", name: "Newer" }], appliesFrom: "next-turn" } as const

    test("a remembered list replaces the recorded seed", () => {
      expect(draftPermissionModes("cursor").modes.map((mode) => mode.id)).toEqual(["agent", "plan", "ask"])
      rememberLiveModes("cursor", { ...live, modes: [...live.modes] })
      expect(draftPermissionModes("cursor").modes.map((mode) => mode.id)).toEqual(["invented-by-a-newer-build"])
    })

    test("an empty report does not erase a good seed", () => {
      // An agent with a mode channel that has not populated it yet reports [].
      // Treating that as "no modes" would throw away a usable seed.
      rememberLiveModes("cursor", { modes: [], appliesFrom: "next-turn" })
      expect(draftPermissionModes("cursor").modes.map((mode) => mode.id)).toEqual(["agent", "plan", "ask"])
    })

    test("a draft never claims another session's current mode", () => {
      rememberLiveModes("cursor", { ...live, modes: [...live.modes], currentModeId: "invented-by-a-newer-build" })
      expect(draftPermissionModes("cursor").currentModeId).toBeUndefined()
    })

    test("learning is per harness", () => {
      rememberLiveModes("cursor", { ...live, modes: [...live.modes] })
      expect(draftPermissionModes("codex").modes.map((mode) => mode.id)).toEqual([
        "read-only",
        "agent",
        "agent-full-access",
      ])
    })
  })
})
