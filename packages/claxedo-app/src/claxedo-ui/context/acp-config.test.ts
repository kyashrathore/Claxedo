import { describe, expect, test } from "bun:test"
import {
  acpScope,
  ACP_DISPLAY_NAMES,
  activeRunner,
  desiredRunner,
  extractModelsFromConfigOptions,
  failedRunner,
  initialRunner,
  initialValue,
  isDraftScope,
  pickRunner,
  type RunnerType,
} from "./acp-config"

describe("acp config helpers", () => {
  // ── pickRunner ───────────────────────────────────────────────────────

  describe("pickRunner", () => {
    test("infers runner from acp binary name", () => {
      expect(pickRunner(undefined, "/tmp/codex-acp")).toBe("codex-acp")
      expect(pickRunner(undefined, "/tmp/claude-agent-acp")).toBe("claude-acp")
      expect(pickRunner(undefined, "/tmp/agent")).toBe("cursor-acp")
      expect(pickRunner(undefined, "/tmp/cursor-agent")).toBe("cursor-acp")
    })

    test("extracts basename from full path before matching", () => {
      expect(pickRunner(undefined, "/usr/local/bin/codex-acp")).toBe("codex-acp")
      expect(pickRunner(undefined, "/home/user/.local/bin/claude-agent-acp")).toBe("claude-acp")
      expect(pickRunner(undefined, "/opt/agents/cursor-agent")).toBe("cursor-acp")
    })

    test("strips .exe suffix when binary has forward slashes", () => {
      expect(pickRunner(undefined, "C:/agents/codex-acp.exe")).toBe("codex-acp")
      expect(pickRunner(undefined, "C:/agents/agent.exe")).toBe("cursor-acp")
    })

    test("matches substring in full path when no forward slash present", () => {
      // backslash paths don't get basename-extracted, but substring match still works
      expect(pickRunner(undefined, "C:\\agents\\codex-acp.exe")).toBe("codex-acp")
      expect(pickRunner(undefined, "C:\\agents\\claude-agent-acp")).toBe("claude-acp")
      // "agent" alone doesn't match via substring since "cursor" not in path
      expect(pickRunner(undefined, "C:\\agents\\agent.exe")).toBeUndefined()
    })

    test("falls back to type when binary does not match any known pattern", () => {
      expect(pickRunner("claude-acp", "/tmp/unknown-binary")).toBe("claude-acp")
      expect(pickRunner("opencode", "/tmp/unknown-binary")).toBe("opencode")
    })

    test("returns valid RunnerType from type string", () => {
      expect(pickRunner("claude-acp")).toBe("claude-acp")
      expect(pickRunner("codex-acp")).toBe("codex-acp")
      expect(pickRunner("cursor-acp")).toBe("cursor-acp")
      expect(pickRunner("opencode")).toBe("opencode")
    })

    test("returns undefined for unknown type without binary", () => {
      expect(pickRunner("unknown")).toBeUndefined()
      expect(pickRunner(undefined)).toBeUndefined()
      expect(pickRunner(null)).toBeUndefined()
    })

    test("binary takes priority over type for classification", () => {
      // binary says codex, type says claude → codex wins
      expect(pickRunner("claude-acp", "/tmp/codex-acp")).toBe("codex-acp")
    })
  })

  // ── desiredRunner / activeRunner ─────────────────────────────────────

  describe("desiredRunner vs activeRunner during switch", () => {
    test("separates desired from active while a switch is in flight", () => {
      const data = {
        type: "codex-acp",
        binary: "/tmp/codex-acp",
        activeType: "claude-acp",
        activeBinary: "/tmp/claude-agent-acp",
      } as const

      expect(desiredRunner(data)).toBe("codex-acp")
      expect(activeRunner(data)).toBe("claude-acp")
    })

    test("desired and active match when no switch is happening", () => {
      const data = {
        type: "claude-acp",
        binary: "/tmp/claude-agent-acp",
        activeType: "claude-acp",
        activeBinary: "/tmp/claude-agent-acp",
      } as const

      expect(desiredRunner(data)).toBe("claude-acp")
      expect(activeRunner(data)).toBe("claude-acp")
    })

    test("activeRunner falls back to type when activeType is missing", () => {
      const data = {
        type: "codex-acp",
        binary: "/tmp/codex-acp",
      } as const

      expect(activeRunner(data)).toBe("codex-acp")
    })
  })

  // ── failedRunner ────────────────────────────────────────────────────

  describe("failedRunner", () => {
    test("treats error status as terminal", () => {
      expect(failedRunner({ type: "codex-acp", status: "error" })).toBe(true)
    })

    test("treats error message as terminal", () => {
      expect(failedRunner({ type: "claude-acp", error: "binary not found" })).toBe(true)
    })

    test("ready state is not failed", () => {
      expect(failedRunner({ type: "claude-acp", status: "ready" })).toBe(false)
    })

    test("no status and no error is not failed", () => {
      expect(failedRunner({ type: "opencode" })).toBe(false)
    })
  })

  // ── acpScope ─────────────────────────────────────────────────────────

  describe("acpScope", () => {
    test("session scope: directory + sessionId", () => {
      const scope = acpScope({ directory: "/tmp/proj", sessionId: "ses_abc" })
      expect(scope).toBe("session:/tmp/proj:ses_abc")
    })

    test("draft scope: directory + tabId (no session)", () => {
      const scope = acpScope({ directory: "/tmp/proj", tabId: "tab_1" })
      expect(scope).toBe("draft:/tmp/proj:tab_1")
    })

    test("new session treated as draft", () => {
      const scope = acpScope({ directory: "/tmp/proj", sessionId: "new", tabId: "tab_2" })
      expect(scope).toBe("draft:/tmp/proj:tab_2")
    })

    test("missing directory still produces valid scope", () => {
      const scope = acpScope({ sessionId: "ses_123" })
      expect(scope).toBe("session::ses_123")
    })

    test("missing tabId defaults to 'route'", () => {
      const scope = acpScope({ directory: "/tmp/proj" })
      expect(scope).toBe("draft:/tmp/proj:route")
    })

    test("different directories produce different scopes", () => {
      const a = acpScope({ directory: "/a", sessionId: "s1" })
      const b = acpScope({ directory: "/b", sessionId: "s1" })
      expect(a).not.toBe(b)
    })

    test("same directory but different sessions produce different scopes", () => {
      const a = acpScope({ directory: "/tmp", sessionId: "s1" })
      const b = acpScope({ directory: "/tmp", sessionId: "s2" })
      expect(a).not.toBe(b)
    })
  })

  describe("draft defaults", () => {
    test("draft scopes ignore legacy runner defaults", () => {
      expect(initialRunner("draft:/tmp/proj:route", undefined, "claude-acp")).toBe("opencode")
      expect(initialRunner("draft:/tmp/proj:route", "codex-acp", "claude-acp")).toBe("codex-acp")
    })

    test("session scopes still honor legacy runner defaults", () => {
      expect(initialRunner("session:/tmp/proj:ses_1", undefined, "claude-acp")).toBe("claude-acp")
    })

    test("draft scopes ignore legacy model and agent values", () => {
      expect(initialValue("draft:/tmp/proj:route", undefined, "opus")).toBe("")
      expect(initialValue("draft:/tmp/proj:route", "sonnet", "opus")).toBe("sonnet")
    })

    test("recognizes draft scopes", () => {
      expect(isDraftScope("draft:/tmp/proj:route")).toBe(true)
      expect(isDraftScope("session:/tmp/proj:ses_1")).toBe(false)
    })
  })

  // ── ACP_DISPLAY_NAMES ───────────────────────────────────────────────

  describe("ACP_DISPLAY_NAMES", () => {
    test("maps all known binary names to display names", () => {
      expect(ACP_DISPLAY_NAMES["claude-agent-acp"]).toBe("Claude")
      expect(ACP_DISPLAY_NAMES["claude-acp"]).toBe("Claude")
      expect(ACP_DISPLAY_NAMES["codex-acp"]).toBe("Codex")
      expect(ACP_DISPLAY_NAMES["agent"]).toBe("Cursor")
      expect(ACP_DISPLAY_NAMES["cursor-agent"]).toBe("Cursor")
      expect(ACP_DISPLAY_NAMES["cursor-acp"]).toBe("Cursor")
      expect(ACP_DISPLAY_NAMES["opencode"]).toBe("OpenCode")
    })

    test("all runner types have a display name", () => {
      const types: RunnerType[] = ["claude-acp", "codex-acp", "cursor-acp", "opencode"]
      for (const t of types) {
        expect(ACP_DISPLAY_NAMES[t]).toBeTruthy()
      }
    })
  })

  describe("extractModelsFromConfigOptions", () => {
    test("returns models from a model select option", () => {
      const result = extractModelsFromConfigOptions([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "opus",
          options: [
            { value: "sonnet", name: "Sonnet" },
            { value: "opus", name: "Opus" },
          ],
        },
      ])

      expect(result).toEqual({
        currentModel: "opus",
        models: [
          { id: "sonnet", name: "Sonnet" },
          { id: "opus", name: "Opus" },
        ],
      })
    })

    test("returns null when no model option exists", () => {
      const result = extractModelsFromConfigOptions([
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "default",
          options: [{ value: "default", name: "Default" }],
        },
      ])

      expect(result).toBeNull()
    })

    test("returns null when model option has no choices", () => {
      const result = extractModelsFromConfigOptions([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "",
          options: [],
        },
      ])

      expect(result).toBeNull()
    })
  })
})
