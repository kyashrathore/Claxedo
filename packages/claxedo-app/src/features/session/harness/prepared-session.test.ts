import { describe, expect, test } from "bun:test"
import {
  planPreparedHarnessSession,
  preparedHarnessSessionModel,
  type PreparedRuntimeSession,
} from "./prepared-session"

const prepared = {
  id: "ses_prepared",
  directory: "/repo",
  harness: { kind: "connection", connectionId: "claude-team" },
  model: "sonnet",
} satisfies PreparedRuntimeSession

describe("prepared harness session planning", () => {
  test("does not prepare when transport is unavailable or directory is absent", () => {
    expect(planPreparedHarnessSession({
      enabled: false,
      directory: "/repo",
      state: { harness: { kind: "connection", connectionId: "claude-team" }, selectedModel: "sonnet" },
    })).toEqual({ status: "disabled" })

    expect(planPreparedHarnessSession({
      enabled: true,
      state: { harness: { kind: "connection", connectionId: "claude-team" }, selectedModel: "sonnet" },
    })).toEqual({ status: "missing-directory" })
  })

  test("prepares generic connections but rejects model-less harnesses", () => {
    expect(preparedHarnessSessionModel({ harness: { kind: "connection", connectionId: "external-opencode" }, selectedModel: "sonnet" })).toBe("sonnet")
    expect(planPreparedHarnessSession({
      enabled: true,
      directory: "/repo",
      state: { harness: { kind: "connection", connectionId: "claude-team" }, selectedModel: "" },
    })).toEqual({ status: "no-model" })
  })

  test("requires a selected Pi model before preparing a session", () => {
    expect(preparedHarnessSessionModel({ harness: { kind: "native", harnessId: "pi" } })).toBeUndefined()
    expect(planPreparedHarnessSession({
      enabled: true,
      directory: "/repo",
      state: { harness: { kind: "native", harnessId: "pi" } },
    })).toEqual({ status: "no-model" })
  })

  test("reuses prepared sessions only when directory harness and model match", () => {
    expect(planPreparedHarnessSession({
      enabled: true,
      directory: "/repo",
      state: { harness: { kind: "connection", connectionId: "claude-team" }, selectedModel: "sonnet" },
      prepared,
    })).toEqual({ status: "reuse", item: prepared })

    expect(planPreparedHarnessSession({
      enabled: true,
      directory: "/repo",
      state: { harness: { kind: "connection", connectionId: "claude-team" }, selectedModel: "opus" },
      prepared,
    })).toEqual({
      status: "create",
      directory: "/repo",
      harness: { kind: "connection", connectionId: "claude-team" },
      model: "opus",
      stale: prepared,
    })
  })

  test("plans stale cleanup when a prepared session does not match", () => {
    expect(planPreparedHarnessSession({
      enabled: true,
      directory: "/other",
      state: { harness: { kind: "connection", connectionId: "claude-team" }, selectedModel: "sonnet" },
      prepared,
    })).toEqual({
      status: "create",
      directory: "/other",
      harness: { kind: "connection", connectionId: "claude-team" },
      model: "sonnet",
      stale: prepared,
    })
  })

  test("stays pure and out of runtime/query/UI layers", async () => {
    const source = await Bun.file(new URL("./prepared-session.ts", import.meta.url)).text()

    expect(source).not.toContain("solid-js")
    expect(source).not.toContain("@tanstack")
    expect(source).not.toContain("queryClient")
    expect(source).not.toContain("@opencode-ai/sdk")
    expect(source).not.toContain("localStorage")
  })
})
