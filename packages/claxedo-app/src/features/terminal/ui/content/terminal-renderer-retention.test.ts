import { describe, expect, test } from "bun:test"
import {
  parseTerminalRendererRetentionMode,
  retainedTerminalRendererIds,
  type TerminalRendererRetentionEntry,
} from "./terminal-renderer-retention"

const entries: TerminalRendererRetentionEntry[] = [
  { id: "active", visible: true, activated: true, lastActive: 4 },
  { id: "recent", visible: false, activated: true, lastActive: 3 },
  { id: "older", visible: false, activated: true, lastActive: 2 },
  { id: "oldest", visible: false, activated: true, lastActive: 1 },
  { id: "never-opened", visible: false, activated: false, lastActive: 0 },
]

describe("terminal renderer retention", () => {
  test("supports the active, active+1, four, and all experiment modes", () => {
    expect([...retainedTerminalRendererIds(entries, "active")]).toEqual(["active"])
    expect([...retainedTerminalRendererIds(entries, "active+1")]).toEqual(["active", "recent"])
    expect([...retainedTerminalRendererIds(entries, "4")]).toEqual(["active", "recent", "older", "oldest"])
    expect([...retainedTerminalRendererIds(entries, "all")]).toEqual(["active", "recent", "older", "oldest"])
  })

  test("visible split panes are never evicted even when they exceed the numeric budget", () => {
    const visible = Array.from({ length: 5 }, (_, index) => ({
      id: `visible-${index}`,
      visible: true,
      activated: true,
      lastActive: index,
    }))
    expect(retainedTerminalRendererIds(visible, "4").size).toBe(5)
  })

  test("four means four total retained views, not four hidden views", () => {
    const withTwoVisible = entries.map((entry) => (entry.id === "recent" ? { ...entry, visible: true } : entry))
    expect([...retainedTerminalRendererIds(withTwoVisible, "4")]).toEqual(["active", "recent", "older", "oldest"])
  })

  test("unknown persisted values fall back to the safe active+1 candidate", () => {
    expect(parseTerminalRendererRetentionMode("all")).toBe("all")
    expect(parseTerminalRendererRetentionMode("bogus")).toBe("active+1")
    expect(parseTerminalRendererRetentionMode(null)).toBe("active+1")
  })
})
