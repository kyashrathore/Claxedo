import { describe, expect, test } from "bun:test"
import { readPartText } from "./message-part-text"
import { localPreviewUrl } from "./local-preview"
import { dispatchSubagentOpen, subagentChips, subagentSubtitle } from "./subagent-chip"
import type { SubagentView } from "../context"

describe("localPreviewUrl", () => {
  test("promotes a dev-server announcement", () => {
    expect(localPreviewUrl("Local: http://127.0.0.1:8766/")).toBe("http://127.0.0.1:8766/")
    expect(localPreviewUrl("ready on http://localhost:3000")).toBe("http://localhost:3000")
    expect(localPreviewUrl("http://0.0.0.0:5173/")).toBe("http://127.0.0.1:5173/")
  })

  test("ignores a control-plane path", () => {
    expect(localPreviewUrl("2593 ? http://127.0.0.1:2593/api/claxedo/mcp?session=qa --flag")).toBeUndefined()
  })

  test("ignores a URL serialized inside a quoted string", () => {
    expect(localPreviewUrl(JSON.stringify({ url: "http://127.0.0.1:2593/api/claxedo/mcp?session=qa", headers: { Authorization: "Bearer REDACTED" } }))).toBeUndefined()
    expect(localPreviewUrl("URL='http://localhost:3000'")).toBeUndefined()
  })

  test("ignores non-loopback and missing URLs", () => {
    expect(localPreviewUrl("listening on https://example.com")).toBeUndefined()
    expect(localPreviewUrl("no url here")).toBeUndefined()
  })
})

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

  test("draws one chip per subagent, whatever resolved it", () => {
    const view = (subagentKey: string, toolCallRole?: "spawn" | "interaction"): SubagentView => ({
      parentSessionId: "parent-1",
      subagentKey,
      status: "running",
      label: "Reviewer",
      agentLabel: "code-reviewer",
      description: "Review auth",
      childSessionId: `child-${subagentKey}`,
      transcriptKind: "messages",
      resolution: "ready",
      ambient: false,
      ...(toolCallRole ? { toolCallRole } : {}),
    })

    expect(subagentChips([view("subagent-1", "spawn"), view("subagent-1", "spawn")]).map((chip) => chip.key))
      .toEqual(["subagent-1"])
    expect(subagentChips([view("subagent-1", "spawn"), view("subagent-2", "spawn")]).map((chip) => chip.key))
      .toEqual(["subagent-1", "subagent-2"])
    expect(subagentChips([view("subagent-1", "spawn"), view("subagent-1", "interaction")])[0]?.toolCallRole)
      .toBe("spawn")
  })

  test("nothing resolved means no chips, so the row has nothing to draw", () => {
    expect(subagentChips([])).toEqual([])
  })

  test("scopes interaction rows to the canonical parent timeline", async () => {
    expect(await Bun.file(`${import.meta.dir}/subagent-chip.tsx`).text()).toContain(
      'data-session-timeline-session-id="${CSS.escape(chip.parentSessionId)}"',
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

  test("carries the agent's name so the opening surface can title the transcript", () => {
    const target = new EventTarget()
    const events: CustomEvent[] = []
    target.addEventListener("claxedo:open-subagent", (event) => events.push(event as CustomEvent))

    dispatchSubagentOpen(target, {
      childSessionId: "child-1",
      subagentKey: "subagent-1",
      label: "code-reviewer",
      interaction: false,
      openable: true,
    })

    expect(events[0]?.detail).toEqual({
      childSessionId: "child-1",
      subagentKey: "subagent-1",
      label: "code-reviewer",
    })
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

describe("subagentSubtitle", () => {
  const findings =
    "Findings below. No files were modified.\n\n## 1. Where tool call parts are rendered as rows\n" +
    "Single dispatch point for every tool invocation in the transcript"

  test("flattens and clamps a summary the runtime wrote into the description", () => {
    const line = subagentSubtitle({ description: findings, resolution: "ready" })
    expect(line).not.toContain("\n")
    expect(line.length).toBeLessThanOrEqual(72)
    expect(line.endsWith("…")).toBe(true)
    expect(line.startsWith("Findings below. No files were modified.")).toBe(true)
  })

  test("keeps a short description whole and appends the row's own facts", () => {
    expect(subagentSubtitle({ description: "Find skill part click handling", mode: "background", resolution: "ready" }))
      .toBe("Find skill part click handling · Background · continues independently")
    expect(subagentSubtitle({ description: "Delegated task", resolution: "unavailable" }))
      .toBe("Delegated task · Transcript unavailable")
  })

  test("an empty description contributes nothing rather than an empty segment", () => {
    expect(subagentSubtitle({ description: "", resolution: "not-yet-bound" })).toBe("Transcript not yet available")
  })
})
