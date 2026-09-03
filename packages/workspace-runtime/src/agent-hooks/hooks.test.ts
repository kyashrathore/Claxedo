import { describe, expect, it } from "bun:test"
import {
  generateNotifyScript,
  generateGeminiHook,
  generateCursorHook,
  generateCopilotHook,
  generateCopilotProjectHooks,
} from "./core/hooks"
import { NOTIFY_MARKER } from "./core/constants"

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

  it("posts lifecycle mutations with the terminal-scoped capability", () => {
    const script = generateNotifyScript(7860)
    expect(script).toContain('curl -s "$HOOK_URL"')
    expect(script).toContain('--request POST')
    expect(script).toContain('Authorization: Bearer $CLAXEDO_AGENT_HOOK_TOKEN')
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
