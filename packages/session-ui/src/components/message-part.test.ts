import { describe, expect, test } from "bun:test"
import { readPartText } from "./message-part-text"
import { dispatchSubagentOpen } from "./subagent-chip"

describe("readPartText", () => {
  test("returns empty string when accum is undefined and part text is undefined", () => {
    expect(readPartText(undefined, { id: "part_1" })).toBe("")
  })

  test("returns trimmed part text when accum is undefined", () => {
    expect(readPartText(undefined, { id: "part_1", text: "  hello  " })).toBe("hello")
  })

  test("prefers accum value over part text when accum has a hit", () => {
    expect(readPartText({ part_1: "  from accum  " }, { id: "part_1", text: "from part" })).toBe("from accum")
  })

  test("falls back to part text when accum misses", () => {
    expect(readPartText({ other_part: "ignored" }, { id: "part_1", text: "  from part  " })).toBe("from part")
  })

  test("returns empty string for whitespace-only text", () => {
    expect(readPartText(undefined, { id: "part_1", text: "   \n\t  " })).toBe("")
  })

  test("trims leading and trailing whitespace", () => {
    expect(readPartText(undefined, { id: "part_1", text: "\n  body  \n" })).toBe("body")
  })
})

describe("cross-harness tool registry", () => {
  test("U2: normalizes harness tool names before registry lookup", async () => {
    expect(await Bun.file(`${import.meta.dir}/message-part.tsx`).text()).toContain(
      "return state[name.toLowerCase()]?.render",
    )
  })

  test("U2: aliases the Claude Agent tool to the task renderer", async () => {
    expect(await Bun.file(`${import.meta.dir}/message-part.tsx`).text()).toMatch(/agent:\s*["']task["']/)
  })

  test("uses only authoritative subagent associations for task cards", async () => {
    const source = await Bun.file(`${import.meta.dir}/message-part.tsx`).text()
    expect(source).not.toContain("unbound-task")
    expect(source).not.toContain("props.metadata.sessionId")
  })

  test("uses only authoritative subagent associations for grouped chips", async () => {
    const source = await Bun.file(`${import.meta.dir}/subagent-chip.tsx`).text()
    expect(source).not.toContain("fallbackChip")
    expect(source).toContain("data.resolveSubagents?.(part.sessionID, part.callID)")
  })

  test("scopes interaction rows to the canonical parent timeline", async () => {
    expect(await Bun.file(`${import.meta.dir}/message-part.tsx`).text()).toContain(
      'data-session-timeline-session-id="${CSS.escape(props.subagent.parentSessionId)}"',
    )
  })
})

describe("dispatchSubagentOpen", () => {
  test("uses the same cancelable pane-open contract for activation", () => {
    const target = new EventTarget()
    const events: CustomEvent[] = []
    target.addEventListener("claxedo:open-subagent", (event) => {
      events.push(event as CustomEvent)
      event.preventDefault()
    })

    expect(dispatchSubagentOpen(target, {
      childSessionId: "child-1",
      subagentKey: "subagent-1",
      interaction: false,
      openable: true,
    })).toBe(true)
    expect(events).toHaveLength(1)
    expect(events[0]?.detail).toEqual({ childSessionId: "child-1", subagentKey: "subagent-1" })
  })

  test("does not emit for interaction rows or unavailable transcripts", () => {
    const target = new EventTarget()
    let count = 0
    target.addEventListener("claxedo:open-subagent", () => count++)

    expect(dispatchSubagentOpen(target, {
      childSessionId: "child-1",
      subagentKey: "subagent-1",
      interaction: true,
      openable: true,
    })).toBe(false)
    expect(dispatchSubagentOpen(target, {
      childSessionId: "child-1",
      subagentKey: "subagent-1",
      interaction: false,
      openable: false,
    })).toBe(false)
    expect(count).toBe(0)
  })
})
