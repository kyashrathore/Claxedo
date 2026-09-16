import { describe, expect, test } from "bun:test"
import path from "node:path"
import { walkProdSources } from "./scanners"
import baseline from "./window-input-listeners-baseline.json"

/**
 * RATCHET: no production module may take user input from `document` or
 * `window` unless it is one of the recorded owners.
 *
 * Why this exists. The workbench keeps surfaces mounted that the user cannot
 * see: the retained hidden tabs of a pane and the other half of a split. A
 * hidden slot is `inert`, `visibility: hidden`, `pointer-events: none`, which
 * stops every input aimed at an element inside it. It stops nothing aimed at
 * the window. A `document.addEventListener("keydown", …)` or a document-level
 * `drop` inside a surface fires for every surface that ever mounted it, and
 * each one acts on its own state. That is how a screenshot dropped on one
 * session was written into another session's draft (every mounted composer
 * took the drop), how ⌘W closed the wrong half of a split (the first pane to
 * register a keybind won), and how typing with nothing focused landed in the
 * last-mounted pane rather than the focused one.
 *
 * Why it is easy to get wrong. From inside a component, `document` is the
 * obvious place to hear a key that no element received, and a listener there
 * works perfectly in a single pane and in every unit test that mounts one
 * surface. The failure appears only with two mounted surfaces, one of which is
 * invisible, and the symptom shows up somewhere else entirely — a draft in
 * another session, a save in a hidden page — with nothing in the stack that
 * names the listener. Gating each handler ("am I the focused pane?") does not
 * fix the shape: it must be repeated in every handler, and the next author who
 * does not know about it reintroduces the bug.
 *
 * What to do instead. A surface asks its slot: `usePaneCtx()`. Keys with no
 * focus arrive through `ctx.onKeyDown` — the workbench holds the one window
 * listener and forwards to the shown surface of the focused pane. Pointer input
 * such as a file drop is bound to `ctx.element()`, the slot, which reaches only
 * the surface it lands on. Keybinds are commands registered with
 * `{ owner: ctx }`, and the registry serves the focused pane's set. Anything
 * still listed in the baseline is a shell singleton with no rival surface, or
 * named debt with its replacement written next to it; a new entry is neither.
 */

const appRoot = path.resolve(import.meta.dir, "../..")

/**
 * Events that carry a user's intent toward a target: keys, text entry,
 * clipboard, drag-and-drop, and the pointer's press. Not listed: pointer
 * moves and releases (a drag session captured on pointerdown must outlive
 * the element under the pointer), and lifecycle events such as `resize`,
 * `visibilitychange`, `blur`, `pagehide`, which name no target at all.
 */
const INPUT_EVENTS = new Set([
  "keydown", "keyup", "keypress", "beforeinput", "input", "paste", "cut", "copy",
  "drop", "dragover", "dragenter", "dragleave", "click", "dblclick", "mousedown",
  "pointerdown", "contextmenu", "wheel",
])

const LISTENER = /(?:document|window)\.addEventListener\(\s*"([^"]+)"|makeEventListener\(\s*(?:document|window)\s*,\s*"([^"]+)"/g

type Recorded = { file: string; events: Record<string, number>; owner: string; reason: string }

export function windowInputListeners(files: { path: string; text: string }[]) {
  const found = new Map<string, Record<string, number>>()
  for (const file of files) {
    for (const match of file.text.matchAll(LISTENER)) {
      const event = match[1] ?? match[2]
      if (!event || !INPUT_EVENTS.has(event)) continue
      const events = found.get(file.path) ?? {}
      events[event] = (events[event] ?? 0) + 1
      found.set(file.path, events)
    }
  }
  return found
}

describe("window input listeners", () => {
  const live = windowInputListeners(walkProdSources(appRoot))
  const recorded = new Map((baseline as Recorded[]).map((entry) => [entry.file, entry]))

  test("no production module takes user input from document or window unless it is a recorded owner", () => {
    const offenders: string[] = []
    for (const [file, events] of live) {
      const entry = recorded.get(file)
      for (const [event, count] of Object.entries(events)) {
        const allowed = entry?.events[event] ?? 0
        if (count > allowed) {
          offenders.push(
            `${file} listens for "${event}" on document/window (${count}, recorded ${allowed}) -- ` +
              "bind it to the surface's slot (`usePaneCtx().element()`), route keys through `ctx.onKeyDown`, " +
              "or register a command with `{ owner }`; adding to window-input-listeners-baseline.json is not the fix",
          )
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test("every recorded owner still exists and still listens, so the baseline cannot go stale", () => {
    const stale: string[] = []
    for (const [file, entry] of recorded) {
      const events = live.get(file)
      for (const [event, count] of Object.entries(entry.events)) {
        const current = events?.[event] ?? 0
        if (current === 0) stale.push(`${file} no longer listens for "${event}" -- remove it from the baseline`)
        else if (current < count) stale.push(`${file} now listens for "${event}" ${current} time(s) < recorded ${count} -- lower the baseline`)
      }
      if (!entry.owner || !entry.reason) stale.push(`${file} needs an owner and a reason`)
    }
    expect(stale).toEqual([])
  })
})
