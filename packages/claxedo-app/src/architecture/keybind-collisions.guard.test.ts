// WP-C2 · registry-wide keyboard-chord collision guard.
//
// This is the single test that enumerates EVERY keyboard-chord binding source
// in claxedo-app and fails on any same-chord double-registration that does not
// have an explicit, documented precedence decision. It supersedes the
// two-source-only check in `app/workbench/rail/rail-keyboard-commands.test.ts`,
// which could only see the rail-registry-vs-workbench pair and was structurally
// blind to the titlebar and session-command call sites that re-introduced the
// exact collisions it was written to catch (see the WP-C2 binding-surface
// inventory, docs/plans/2026-07-11-006).
//
// Two classes of source:
//   * IMPORTED — chords come from a pure production export (rail, layout,
//     workbench, prompt-mode). These can never drift from the code because the
//     test exercises the real function/constant.
//   * DECLARED — chords are registered inline inside a Solid component
//     (titlebar.tsx, use-session-commands.tsx, app-shell-commands.ts) that
//     cannot be imported without a full mount. Each declared binding carries an
//     `evidence` substring; `declared sources still exist in source` below reads
//     the owning file and asserts the evidence is present, so a rename/removal
//     in production fails this guard instead of silently desyncing the inventory.
//
// KNOWN_CHORD_COLLISIONS is the explicit precedence policy. Seeding a collision
// here is a deliberate, reviewed decision (recorded in the WP-C2 report), not a
// grandfather clause: the list is shrink-only (a stale entry that no longer
// corresponds to a live collision fails the guard), and any NEW collision that
// is not listed fails the guard.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { createRailKeyboardCommands } from "../app/workbench/rail/rail-keyboard-commands"
import { createProcessPaneToggleCommand } from "../app/workbench/rail/layout-commands"
import { resolveKeyMap } from "../app/workbench/workbench/keyboard"
import { promptShellModeKey, promptNormalModeKey } from "../features/session/composer/ui/mode-commands"

type BindingSourceId =
  | "rail-keyboard-commands"
  | "layout-process-pane"
  | "workbench-keyboard"
  | "prompt-mode-commands"
  | "titlebar-tab-bindings"
  | "titlebar-history"
  | "titlebar-quit-capture"
  | "session-commands"
  | "app-shell-commands"

interface ChordBinding {
  chord: string // canonical, platform-agnostic signature
  raw: string
  commandId: string
  source: BindingSourceId
}

// Platform-agnostic chord normalizer used ONLY for comparison in this guard.
// It intentionally does not reuse command-palette's `parseKeybind` (which keys
// "mod" to metaKey/ctrlKey by platform and drags the whole context module — and
// its DOM/Solid deps — into a bun:test). "option" collapses to "alt" and
// "cmd/command" to "meta" so `mod+option+ArrowLeft` (titlebar) and
// `mod+alt+ArrowLeft` (workbench) are recognized as the same chord — the exact
// alias the audit flagged. Modifier order is normalized so `shift+mod+.` and
// `mod+shift+.` compare equal.
const MOD_ALIASES: Record<string, string> = {
  option: "alt",
  control: "ctrl",
  cmd: "meta",
  command: "meta",
}
const MOD_ORDER = ["ctrl", "alt", "shift", "meta", "mod"]

function canonicalizeChord(raw: string): string {
  const parts = raw.trim().toLowerCase().split("+").map((p) => p.trim()).filter(Boolean)
  const mods: string[] = []
  let key = ""
  for (const part of parts) {
    const norm = MOD_ALIASES[part] ?? part
    if (MOD_ORDER.includes(norm)) mods.push(norm)
    else key = norm
  }
  const uniqueMods = [...new Set(mods)].sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b))
  return [...uniqueMods, key].filter(Boolean).join("+")
}

const noopRailActions = {
  closeFocusedPane: () => {},
  showNextSurface: () => {},
  showPreviousSurface: () => {},
  toggleSidebar: () => {},
  showSurfaceAtIndex: () => {},
  focusSplitLeft: () => {},
  focusSplitRight: () => {},
}

// ---- IMPORTED sources (chords come from real production exports) ------------

function importedBindings(): ChordBinding[] {
  const out: ChordBinding[] = []

  for (const command of createRailKeyboardCommands(noopRailActions)) {
    if (typeof command.keybind === "string")
      out.push({ source: "rail-keyboard-commands", commandId: command.id, raw: command.keybind, chord: canonicalizeChord(command.keybind) })
  }

  const processPane = createProcessPaneToggleCommand(() => {})
  if (typeof processPane.keybind === "string")
    out.push({ source: "layout-process-pane", commandId: processPane.id, raw: processPane.keybind, chord: canonicalizeChord(processPane.keybind) })

  for (const [action, chord] of Object.entries(resolveKeyMap(undefined)))
    out.push({ source: "workbench-keyboard", commandId: `workbench.${action}`, raw: chord, chord: canonicalizeChord(chord) })

  // prompt-input local keymap: mode toggles use exported constants (imported,
  // drift-proof); the file-attach chord is a literal in mode-commands.ts, kept
  // honest by the mode-commands evidence assertion below.
  for (const [commandId, raw] of [
    ["file.attach", "mod+u"],
    ["prompt.mode.shell", promptShellModeKey],
    ["prompt.mode.normal", promptNormalModeKey],
  ] as const)
    out.push({ source: "prompt-mode-commands", commandId, raw, chord: canonicalizeChord(raw) })

  return out
}

// ---- DECLARED sources (inline in components; grep-guarded for drift) --------

interface DeclaredBinding {
  commandId: string
  raw: string
  evidence: string // substring that must still appear in `file`
  // The exact literal that appears after `keybind:` in the owning file, used by
  // the reverse source-scan below. Defaults to `raw`. Use a template string when
  // the file declares one chord for several commands (`mod+${number}`); use
  // `null` for bindings that are NOT declared as a `keybind:` literal at all
  // (e.g. the capture-phase Cmd+W listener), so the scan does not expect them.
  sourceToken?: string | null
}
interface DeclaredSource {
  source: BindingSourceId
  file: string // relative to this test file
  bindings: DeclaredBinding[]
}

const DECLARED_SOURCES: DeclaredSource[] = [
  {
    source: "session-commands",
    file: "../features/session/ui/use-session-commands.tsx",
    bindings: [
      { commandId: "session.new", raw: "mod+shift+s", evidence: `"mod+shift+s"` },
      { commandId: "file.open", raw: "mod+p", evidence: `"mod+p"` },
      { commandId: "tab.close", raw: "mod+w", evidence: `"mod+w"` },
      { commandId: "context.addSelection", raw: "mod+shift+l", evidence: `"mod+shift+l"` },
      { commandId: "review.toggle", raw: "mod+shift+r", evidence: `"mod+shift+r"` },
      { commandId: "fileTree.toggle", raw: "mod+shift+e", evidence: `"mod+shift+e"` },
      { commandId: "input.focus", raw: "ctrl+l", evidence: `"ctrl+l"` },
      { commandId: "terminal.new", raw: "ctrl+alt+t", evidence: `"ctrl+alt+t"` },
      { commandId: "terminal.toggle", raw: "ctrl+`", evidence: '"ctrl+`"' },
      { commandId: "steps.toggle", raw: "mod+e", evidence: `"mod+e"` },
      { commandId: "message.previous", raw: "mod+arrowup", evidence: `"mod+arrowup"` },
      { commandId: "message.next", raw: "mod+arrowdown", evidence: `"mod+arrowdown"` },
      { commandId: "model.choose", raw: "mod+'", evidence: `"mod+'"` },
      { commandId: "mcp.toggle", raw: "mod+;", evidence: `"mod+;"` },
      { commandId: "agent.cycle", raw: "mod+.", evidence: `"mod+."` },
      { commandId: "agent.cycle.reverse", raw: "shift+mod+.", evidence: `"shift+mod+."` },
      { commandId: "model.variant.cycle", raw: "shift+mod+d", evidence: `"shift+mod+d"` },
      { commandId: "permissions.autoaccept", raw: "mod+shift+a", evidence: `"mod+shift+a"` },
    ],
  },
  {
    source: "titlebar-tab-bindings",
    file: "../app/workbench/titlebar/titlebar.tsx",
    bindings: [
      { commandId: "tab.prev", raw: "mod+option+ArrowLeft", evidence: "mod+option+ArrowLeft" },
      { commandId: "tab.next", raw: "mod+option+ArrowRight", evidence: "mod+option+ArrowRight" },
      // tab.1..tab.9 are one template: keybind: `mod+${number}`.
      ...Array.from({ length: 9 }, (_, i) => ({
        commandId: `tab.${i + 1}`,
        raw: `mod+${i + 1}`,
        evidence: "mod+${number}",
        sourceToken: "mod+${number}",
      })),
    ],
  },
  {
    source: "titlebar-history",
    file: "../app/workbench/titlebar/titlebar.tsx",
    bindings: [
      { commandId: "common.goBack", raw: "mod+[", evidence: `"mod+["` },
      { commandId: "common.goForward", raw: "mod+]", evidence: `"mod+]"` },
    ],
  },
  {
    source: "titlebar-quit-capture",
    file: "../app/workbench/titlebar/titlebar.tsx",
    // Capture-phase listener that matches Cmd/Meta+W with no other modifiers.
    // There is no literal "mod+w" string; the evidence is the match guard.
    bindings: [
      { commandId: "titlebar.tab.close.capture", raw: "mod+w", evidence: `event.key.toLowerCase() !== "w"`, sourceToken: null },
    ],
  },
  {
    source: "app-shell-commands",
    file: "../app/app-shell-commands.ts",
    bindings: [{ commandId: "theme.scheme.cycle", raw: "mod+shift+s", evidence: `"mod+shift+s"` }],
  },
]

function declaredBindings(): ChordBinding[] {
  return DECLARED_SOURCES.flatMap((declared) =>
    declared.bindings.map((binding) => ({
      source: declared.source,
      commandId: binding.commandId,
      raw: binding.raw,
      chord: canonicalizeChord(binding.raw),
    })),
  )
}

function allBindings(): ChordBinding[] {
  return [...importedBindings(), ...declaredBindings()]
}

// ---- Explicit precedence policy for known collisions ------------------------

interface CollisionDecision {
  chord: string // canonical
  decision: string
  phase2?: boolean
}

const KNOWN_CHORD_COLLISIONS: CollisionDecision[] = [
  {
    chord: canonicalizeChord("mod+w"),
    // Order of specificity: titlebar session-tab close (capture-phase, V2
    // titlebar) > session-commands tab.close (file tab) > workbench closePane
    // (pane) > rail claxedo.pane.close (palette-only; owns the desktop last-pane
    // Quit dialog). Unifying all four behind a single `claxedo.pane.close`
    // command that internally walks that fallback chain is WP-C2 phase 2 — it
    // requires migrating the workbench window-listener, which is out of phase-1
    // ownership. See WP-C2 report §W9.
    decision:
      "capture(titlebar session-tab) > tab.close(file tab) > workbench closePane(pane) > claxedo.pane.close(last-pane Quit). Single-owner unification deferred to WP-C2 phase 2 (workbench listener migration).",
    phase2: true,
  },
  {
    chord: canonicalizeChord("mod+shift+s"),
    // command-palette keymap is first-registered-wins: session.new mounts before
    // theme.scheme.cycle, so session.new owns the chord. theme.scheme.cycle stays
    // palette-invokable. Re-chording theme.scheme.cycle touches app-shell-commands.ts
    // (outside phase-1 ownership) — deferred.
    decision: "session.new owns mod+shift+s (first-registered); theme.scheme.cycle is palette-only until re-chorded. Deferred (app-shell-commands.ts).",
    phase2: true,
  },
  {
    chord: canonicalizeChord("mod+shift+e"),
    // fileTree.toggle (session registry) is the app-level owner. prompt.mode.normal
    // is bound on the same chord but only fires from the prompt editor's element-
    // scoped onKeyDown (which runs before the event bubbles to the registry
    // document listener), so there is no runtime double-fire; the registry keymap
    // still resolves fileTree.toggle first. Both surfaces are outside phase-1's
    // editable ownership; the shared chord is intentional and documented.
    decision: "fileTree.toggle owns mod+shift+e in the registry; prompt.mode.normal is prompt-editor-local (fires before bubbling). No runtime double-fire.",
  },
  {
    chord: canonicalizeChord("mod+alt+ArrowLeft"),
    decision: "workbench focusLeft (geometric pane focus) owns mod+alt+Arrow; titlebar tab.prev (hidden session-tab cycle) is superseded/undiscoverable. Re-chord or drop in phase 2.",
    phase2: true,
  },
  {
    chord: canonicalizeChord("mod+alt+ArrowRight"),
    decision: "workbench focusRight (geometric pane focus) owns mod+alt+Arrow; titlebar tab.next (hidden session-tab cycle) is superseded/undiscoverable. Re-chord or drop in phase 2.",
    phase2: true,
  },
  ...Array.from({ length: 9 }, (_, i) => ({
    chord: canonicalizeChord(`mod+${i + 1}`),
    decision:
      "rail claxedo.surface.N (workbench surface switch, palette-visible) owns mod+N; titlebar tab.N (hidden session-tab jump) is superseded/undiscoverable. Re-chord or drop in phase 2.",
    phase2: true,
  })),
]

// ---------------------------------------------------------------------------

function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
}

// Extract every declared keybind chord LITERAL from a source file. Matches only
// object-property `keybind:` declarations (single-quote, double-quote, or
// backtick). It deliberately does NOT match `keybind={command.keybind("id")}`
// JSX-prop references (those use `keybind=` and point at a command id, not a
// chord). This is the reverse of the evidence assertion: instead of proving each
// inventory entry still exists in the file, it proves the file introduces no
// chord the inventory has not accounted for — so a newly added colliding chord
// in a declared component can no longer slip in undetected.
function scanKeybindTokens(text: string): string[] {
  const re = /keybind:\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)/g
  const tokens: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) tokens.push(m[1] ?? m[2] ?? m[3]!)
  return tokens
}

// Tokens the inventory claims each declared FILE should contain (union across
// the sources that share a file). `sourceToken === null` bindings are excluded
// (not declared as a `keybind:` literal); otherwise the token is `sourceToken`
// or, by default, `raw`.
function inventoryTokensByFile(): Map<string, Set<string>> {
  const byFile = new Map<string, Set<string>>()
  for (const declared of DECLARED_SOURCES) {
    const set = byFile.get(declared.file) ?? new Set<string>()
    for (const binding of declared.bindings) {
      const token = binding.sourceToken === undefined ? binding.raw : binding.sourceToken
      if (token !== null) set.add(token)
    }
    byFile.set(declared.file, set)
  }
  return byFile
}

function collisions(bindings: ChordBinding[]) {
  const byChord = new Map<string, ChordBinding[]>()
  for (const binding of bindings) {
    const list = byChord.get(binding.chord) ?? []
    list.push(binding)
    byChord.set(binding.chord, list)
  }
  return [...byChord.entries()]
    .map(([chord, list]) => ({ chord, list, commandIds: [...new Set(list.map((b) => b.commandId))] }))
    .filter((entry) => entry.commandIds.length > 1)
}

describe("WP-C2 keyboard binding surface", () => {
  test("declared sources still exist in source (drift guard)", () => {
    const missing: string[] = []
    const byFile = new Map<string, string>()
    for (const declared of DECLARED_SOURCES) {
      const text = byFile.get(declared.file) ?? readSource(declared.file)
      byFile.set(declared.file, text)
      for (const binding of declared.bindings) {
        if (!text.includes(binding.evidence))
          missing.push(`${declared.source}:${binding.commandId} — evidence ${JSON.stringify(binding.evidence)} not found in ${declared.file}`)
      }
    }
    expect(missing).toEqual([])
  })

  test("declared source files contain NO keybind chord beyond the inventory (reverse drift guard)", () => {
    // Teeth the previous evidence-only check lacked: the evidence assertion is
    // inventory→file (each listed chord still present); this is file→inventory
    // (no chord present that the inventory has not enrolled into collision
    // analysis). A new `keybind: "…"` added to any declared component that is not
    // mirrored in DECLARED_SOURCES fails HERE, and once mirrored it is subject to
    // the collision guard below — so a newly added colliding chord can no longer
    // hide in a DECLARED (non-imported) source.
    const expectedByFile = inventoryTokensByFile()
    const problems: string[] = []
    for (const [file, expected] of expectedByFile) {
      const scanned = new Set(scanKeybindTokens(readSource(file)))
      for (const token of scanned)
        if (!expected.has(token))
          problems.push(
            `${file}: keybind ${JSON.stringify(token)} is declared in source but absent from the WP-C2 inventory — add it to DECLARED_SOURCES so it enters collision analysis`,
          )
      for (const token of expected)
        if (!scanned.has(token))
          problems.push(`${file}: inventory expects keybind ${JSON.stringify(token)} but it is no longer declared in source (renamed/removed?)`)
    }
    expect(problems).toEqual([])
  })

  test("prompt-input file-attach chord literal still exists (mod+u drift guard)", () => {
    expect(readSource("../features/session/composer/ui/mode-commands.ts")).toContain(`"mod+u"`)
  })

  test("terminal.toggle ghost command is now registered with its Ctrl+` chord", () => {
    // §0.4 of the inventory: terminal.toggle was referenced by 3 call sites but
    // never registered. WP-C2 registers it in use-session-commands.tsx.
    const session = readSource("../features/session/ui/use-session-commands.tsx")
    expect(session).toContain(`id: "terminal.toggle"`)
    expect(session).toContain('"ctrl+`"')
  })

  test("every chord collision has an explicit, documented precedence decision", () => {
    const known = new Set(KNOWN_CHORD_COLLISIONS.map((entry) => entry.chord))
    const undocumented = collisions(allBindings())
      .filter((entry) => !known.has(entry.chord))
      .map((entry) => `${entry.chord} bound by [${entry.commandIds.join(", ")}] with no precedence decision`)
    expect(undocumented).toEqual([])
  })

  test("known-collision baseline is shrink-only (no stale precedence entries)", () => {
    const live = new Set(collisions(allBindings()).map((entry) => entry.chord))
    const stale = KNOWN_CHORD_COLLISIONS.map((entry) => entry.chord).filter((chord) => !live.has(chord))
    expect(stale).toEqual([])
  })

  test("enumerates every binding source in the inventory", () => {
    const sources = new Set(allBindings().map((binding) => binding.source))
    expect([...sources].sort()).toEqual(
      [
        "app-shell-commands",
        "layout-process-pane",
        "prompt-mode-commands",
        "rail-keyboard-commands",
        "session-commands",
        "titlebar-history",
        "titlebar-quit-capture",
        "titlebar-tab-bindings",
        "workbench-keyboard",
      ].sort(),
    )
  })

  test("mod+w is bound by exactly the three live handlers the inventory names", () => {
    const modW = collisions(allBindings()).find((entry) => entry.chord === canonicalizeChord("mod+w"))
    expect(modW?.commandIds.sort()).toEqual(["tab.close", "titlebar.tab.close.capture", "workbench.closePane"].sort())
  })
})
