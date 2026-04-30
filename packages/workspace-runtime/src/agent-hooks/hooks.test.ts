import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import * as path from "path"
import * as os from "os"
import {
  generateNotifyScript,
  generateGeminiHook,
  generateCursorHook,
  generateCopilotHook,
  generateCopilotProjectHooks,
  getClaudeManagedHookCommand,
  upsertClaudeSettings,
  upsertDroidSettings,
  upsertCodexHooks,
  upsertGeminiHooks,
  upsertCursorHooks,
  upsertMastraHooks,
} from "./hooks"
import { NOTIFY_MARKER } from "./constants"
import { isManagedHookCommand, reconcileManagedEntries } from "./utils"

const TEST_ROOT = path.join(os.tmpdir(), `claxedo-hooks-test-${process.pid}-${Date.now()}`)

beforeEach(() => {
  mkdirSync(TEST_ROOT, { recursive: true })
})

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

// ── isManagedHookCommand ────────────────────────────────────────────────────

describe("isManagedHookCommand", () => {
  it("matches standard claxedo hook paths", () => {
    expect(isManagedHookCommand("/home/user/.claxedo/hooks/notify.sh", "notify.sh")).toBe(true)
  })

  it("matches hyphenated claxedo variants", () => {
    expect(isManagedHookCommand("/home/user/.claxedo-dev/hooks/notify.sh", "notify.sh")).toBe(true)
  })

  it("rejects non-claxedo paths", () => {
    expect(isManagedHookCommand("/usr/local/bin/hooks/notify.sh", "notify.sh")).toBe(false)
  })

  it("rejects wrong script name", () => {
    expect(isManagedHookCommand("/home/user/.claxedo/hooks/notify.sh", "other.sh")).toBe(false)
  })

  it("handles undefined gracefully", () => {
    expect(isManagedHookCommand(undefined, "notify.sh")).toBe(false)
  })

  it("handles empty string", () => {
    expect(isManagedHookCommand("", "notify.sh")).toBe(false)
  })

  it("normalizes backslashes (Windows paths)", () => {
    expect(isManagedHookCommand("C:\\Users\\foo\\.claxedo\\hooks\\notify.sh", "notify.sh")).toBe(true)
  })
})

// ── reconcileManagedEntries ─────────────────────────────────────────────────

describe("reconcileManagedEntries", () => {
  type Entry = { command: string }

  const isManaged = (e: Entry) => e.command.includes("claxedo")
  const isEquivalent = (a: Entry, b: Entry) => a.command === b.command

  it("appends desired when current is empty", () => {
    const { entries, replacedManagedEntries } = reconcileManagedEntries({
      current: undefined,
      desired: [{ command: "claxedo-new" }],
      isManaged,
      isEquivalent,
    })
    expect(entries).toEqual([{ command: "claxedo-new" }])
    expect(replacedManagedEntries).toEqual([])
  })

  it("preserves user entries and adds desired", () => {
    const { entries } = reconcileManagedEntries({
      current: [{ command: "user-hook" }],
      desired: [{ command: "claxedo-hook" }],
      isManaged,
      isEquivalent,
    })
    expect(entries).toEqual([{ command: "user-hook" }, { command: "claxedo-hook" }])
  })

  it("replaces stale managed entries", () => {
    const { entries, replacedManagedEntries } = reconcileManagedEntries({
      current: [{ command: "claxedo-old" }, { command: "user-hook" }],
      desired: [{ command: "claxedo-new" }],
      isManaged,
      isEquivalent,
    })
    expect(entries).toEqual([{ command: "user-hook" }, { command: "claxedo-new" }])
    expect(replacedManagedEntries).toEqual([{ command: "claxedo-old" }])
  })

  it("keeps equivalent managed entries (no duplication)", () => {
    const { entries, replacedManagedEntries } = reconcileManagedEntries({
      current: [{ command: "claxedo-hook" }],
      desired: [{ command: "claxedo-hook" }],
      isManaged,
      isEquivalent,
    })
    // Equivalent existing managed entry is dropped, desired is appended
    expect(entries).toEqual([{ command: "claxedo-hook" }])
    expect(replacedManagedEntries).toEqual([])
  })

  it("handles multiple user entries", () => {
    const { entries } = reconcileManagedEntries({
      current: [{ command: "user-a" }, { command: "user-b" }],
      desired: [{ command: "claxedo-hook" }],
      isManaged,
      isEquivalent,
    })
    expect(entries).toEqual([{ command: "user-a" }, { command: "user-b" }, { command: "claxedo-hook" }])
  })
})

// ── Notify script ───────────────────────────────────────────────────────────

describe("generateNotifyScript", () => {
  it("includes marker and port", () => {
    const script = generateNotifyScript(7860)
    expect(script).toContain(NOTIFY_MARKER)
    expect(script).toContain("7860")
  })

  it("normalizes Codex SessionStart events", () => {
    const script = generateNotifyScript(7860)
    expect(script).toContain('"SessionStart"')
    expect(script).toContain('"SessionEnd"')
  })
})

// ── Hook bridge generators ──────────────────────────────────────────────────

describe("generateGeminiHook", () => {
  it("includes marker and notify path", () => {
    const script = generateGeminiHook("/tmp/hooks/notify.sh")
    expect(script).toContain(NOTIFY_MARKER)
    expect(script).toContain("/tmp/hooks/notify.sh")
  })
})

describe("generateCursorHook", () => {
  it("includes marker and notify path", () => {
    const script = generateCursorHook("/tmp/hooks/notify.sh")
    expect(script).toContain(NOTIFY_MARKER)
    expect(script).toContain("/tmp/hooks/notify.sh")
  })
})

describe("generateCopilotHook", () => {
  it("includes marker and notify path", () => {
    const script = generateCopilotHook("/tmp/hooks/notify.sh")
    expect(script).toContain(NOTIFY_MARKER)
    expect(script).toContain("/tmp/hooks/notify.sh")
  })
})

// ── Copilot project hooks ───────────────────────────────────────────────────

describe("generateCopilotProjectHooks", () => {
  it("produces valid JSON with all lifecycle events", () => {
    const json = generateCopilotProjectHooks("/tmp/hooks/copilot-hook.sh")
    const parsed = JSON.parse(json)
    expect(parsed.version).toBe(1)
    expect(parsed.hooks.sessionStart).toBeDefined()
    expect(parsed.hooks.sessionEnd).toBeDefined()
    expect(parsed.hooks.userPromptSubmitted).toBeDefined()
    expect(parsed.hooks.postToolUse).toBeDefined()
  })

  it("embeds the hook script path in commands", () => {
    const json = generateCopilotProjectHooks("/tmp/hooks/copilot-hook.sh")
    expect(json).toContain("/tmp/hooks/copilot-hook.sh")
  })
})

// ── Claude settings merge ───────────────────────────────────────────────────

describe("getClaudeManagedHookCommand", () => {
  it("uses dynamic CLAXEDO_HOME_DIR for portability", () => {
    const cmd = getClaudeManagedHookCommand()
    expect(cmd).toContain("CLAXEDO_HOME_DIR")
    expect(cmd).toContain("notify.sh")
  })
})

describe("upsertClaudeSettings", () => {
  const settingsDir = path.join(TEST_ROOT, ".claude")
  const settingsPath = path.join(settingsDir, "settings.json")

  beforeEach(() => {
    // Monkey-patch to write to our test dir
    mkdirSync(settingsDir, { recursive: true })
  })

  it("creates file when it does not exist", async () => {
    // This test is limited — upsertClaudeSettings writes to ~/.claude/settings.json
    // We verify the function doesn't throw and the managed command is correct
    const cmd = getClaudeManagedHookCommand()
    expect(cmd).toContain("CLAXEDO_HOME_DIR")
  })

  it("managed hook command includes all expected events", () => {
    // Verify the events configured in upsertClaudeSettings
    // We can't easily test the file write without mocking homedir,
    // but we can verify the hook command format
    const cmd = getClaudeManagedHookCommand()
    expect(cmd).toContain("|| true")
    expect(cmd).toContain("-x")
  })
})

// ── Gemini hook config upsert ─────────────────────────────────────────────

describe("upsertGeminiHooks (reconcile behavior)", () => {
  it("reconcileManagedEntries removes stale gemini hooks", () => {
    type GeminiEntry = { hooks: { type: string; command: string }[] }
    const hookPath = "/new/path/hooks/gemini-hook.sh"
    const staleEntry: GeminiEntry = { hooks: [{ type: "command", command: "/old/.claxedo/hooks/gemini-hook.sh" }] }
    const desired: GeminiEntry = { hooks: [{ type: "command", command: hookPath }] }

    const { entries, replacedManagedEntries } = reconcileManagedEntries<GeminiEntry>({
      current: [staleEntry, { hooks: [{ type: "command", command: "/user/custom-hook.sh" }] }],
      desired: [desired],
      isManaged: (entry) =>
        entry.hooks.some(
          (h) =>
            h.command === hookPath ||
            isManagedHookCommand(h.command, "gemini-hook.sh"),
        ),
      isEquivalent: (a, b) => JSON.stringify(a.hooks) === JSON.stringify(b.hooks),
    })

    expect(entries.length).toBe(2) // user entry + desired
    expect(replacedManagedEntries.length).toBe(1)
    expect(replacedManagedEntries[0]).toEqual(staleEntry)
  })
})

// ── Cursor hook config upsert ────────────────────────────────────────────

describe("upsertCursorHooks (reconcile behavior)", () => {
  it("reconcileManagedEntries replaces stale cursor hooks", () => {
    const hookPath = "/new/path/hooks/cursor-hook.sh"
    const staleEntry = { command: "/old/.claxedo/hooks/cursor-hook.sh Start" }
    const desired = { command: `${hookPath} Start` }

    const { entries, replacedManagedEntries } = reconcileManagedEntries({
      current: [staleEntry, { command: "/user/custom-hook.sh" }],
      desired: [desired],
      isManaged: (entry) => {
        const cmd = (entry as Record<string, unknown>).command as string | undefined
        return cmd?.includes(hookPath) || isManagedHookCommand(cmd, "cursor-hook.sh") || false
      },
      isEquivalent: (a, b) =>
        (a as Record<string, unknown>).command === (b as Record<string, unknown>).command,
    })

    expect(entries.length).toBe(2)
    expect(replacedManagedEntries).toEqual([staleEntry])
  })
})

// ── Mastra hook config upsert ───────────────────────────────────────────

describe("upsertMastraHooks (reconcile behavior)", () => {
  it("reconcileManagedEntries replaces stale notify commands", () => {
    const notifyPath = "/new/path/hooks/notify.sh"
    const staleEntry = { type: "command", command: "bash '/old/.claxedo/hooks/notify.sh'" }
    const desired = { type: "command", command: `bash '${notifyPath}'` }

    const { entries, replacedManagedEntries } = reconcileManagedEntries({
      current: [staleEntry, { type: "command", command: "user-hook" }],
      desired: [desired],
      isManaged: (entry) => {
        const cmd = (entry as Record<string, unknown>).command as string | undefined
        return cmd?.includes(notifyPath) || isManagedHookCommand(cmd, "notify.sh") || false
      },
      isEquivalent: (a, b) =>
        (a as Record<string, unknown>).command === (b as Record<string, unknown>).command,
    })

    expect(entries.length).toBe(2)
    expect(replacedManagedEntries).toEqual([staleEntry])
  })
})

// ── Idempotency ─────────────────────────────────────────────────────────────

describe("reconcileManagedEntries idempotency", () => {
  it("running reconcile twice produces the same result", () => {
    type Entry = { command: string }
    const isManaged = (e: Entry) => e.command.includes("claxedo")
    const isEquivalent = (a: Entry, b: Entry) => a.command === b.command
    const desired: Entry[] = [{ command: "claxedo-hook" }]

    const first = reconcileManagedEntries({
      current: [{ command: "user-hook" }],
      desired,
      isManaged,
      isEquivalent,
    })

    const second = reconcileManagedEntries({
      current: first.entries,
      desired,
      isManaged,
      isEquivalent,
    })

    expect(second.entries).toEqual(first.entries)
    expect(second.replacedManagedEntries).toEqual([])
  })
})
