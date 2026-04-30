import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { render, cleanup, fireEvent } from "@solidjs/testing-library"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const setRunnerCalls: Array<{ scope: string; type: string }> = []
let readiness = "ready"

vi.mock("@solidjs/router", () => ({
  useParams: () => ({ id: undefined, dir: undefined }),
}))

vi.mock("@claxedo/claxedo-ui/context/session-params", () => ({
  useSessionParams: () => {
    throw new Error("not in split mode")
  },
}))

vi.mock("@opencode-ai/util/encode", () => ({
  base64Decode: (v: string) => v,
}))

vi.mock("@claxedo/claxedo-ui/context/acp-config", () => ({
  useAcpConfig: () => ({
    hydrate: vi.fn(),
    runner: () => "claude-acp",
    readiness: () => readiness,
    isAcpMode: () => true,
    models: () => [],
    selectedModel: () => "",
    configError: () => undefined,
    setRunner: (scope: string, type: string) => {
      setRunnerCalls.push({ scope, type })
    },
    setModel: vi.fn(),
  }),
}))

vi.mock("../../pane/store/pane-preferences", () => ({
  panePreferenceScope: () => "test-scope",
}))

// Stub Select to expose trigger + option buttons in the DOM
vi.mock("@opencode-ai/ui/select", () => ({
  Select: (props: any) => {
    return (
      <div data-testid="select" data-disabled={props.disabled ? "true" : "false"}>
        <button
          data-testid="select-trigger"
          disabled={props.disabled}
        >
          {props.label?.(props.current) ?? props.current}
        </button>
        {(props.options as string[]).map((opt: string) => (
          <button
            data-testid={`select-option-${opt}`}
            onClick={() => props.onSelect?.(opt)}
          >
            {props.label?.(opt) ?? opt}
          </button>
        ))}
      </div>
    )
  },
}))

vi.mock("@/components/dialog-select-model", () => ({
  ModelSelectorPopover: (props: any) => <div data-testid="model-selector">{props.children}</div>,
}))

import { AgentRunnerSelector } from "./agent-runner-selector"

afterEach(() => {
  cleanup()
  setRunnerCalls.length = 0
})

beforeEach(() => {
  readiness = "ready"
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentRunnerSelector — sessionLocked guard", () => {
  test("trigger is enabled when sessionLocked is false (new session)", () => {
    const { container } = render(() => <AgentRunnerSelector sessionLocked={false} />)
    const trigger = container.querySelector("[data-testid='select-trigger']") as HTMLButtonElement
    expect(trigger).not.toBeNull()
    expect(trigger.disabled).toBe(false)
  })

  test("trigger is disabled when sessionLocked is true (existing session)", () => {
    const { container } = render(() => <AgentRunnerSelector sessionLocked={true} />)
    const trigger = container.querySelector("[data-testid='select-trigger']") as HTMLButtonElement
    expect(trigger).not.toBeNull()
    expect(trigger.disabled).toBe(true)
  })

  test("trigger is disabled while polling", () => {
    readiness = "polling"
    const { container } = render(() => <AgentRunnerSelector sessionLocked={false} />)
    const trigger = container.querySelector("[data-testid='select-trigger']") as HTMLButtonElement
    expect(trigger).not.toBeNull()
    expect(trigger.disabled).toBe(true)
  })

  test("select data-disabled attribute reflects lock state", () => {
    const { container: unlocked } = render(() => <AgentRunnerSelector sessionLocked={false} />)
    expect(unlocked.querySelector("[data-testid='select']")!.getAttribute("data-disabled")).toBe("false")
    cleanup()

    const { container: locked } = render(() => <AgentRunnerSelector sessionLocked={true} />)
    expect(locked.querySelector("[data-testid='select']")!.getAttribute("data-disabled")).toBe("true")
  })

  test("clicking an option calls setRunner when unlocked", () => {
    const { container } = render(() => <AgentRunnerSelector sessionLocked={false} />)
    const option = container.querySelector("[data-testid='select-option-codex-acp']") as HTMLButtonElement
    expect(option).not.toBeNull()

    fireEvent.click(option)
    expect(setRunnerCalls).toHaveLength(1)
    expect(setRunnerCalls[0].type).toBe("codex-acp")
  })

  test("clicking an option does NOT call setRunner when locked", () => {
    const { container } = render(() => <AgentRunnerSelector sessionLocked={true} />)
    const option = container.querySelector("[data-testid='select-option-codex-acp']") as HTMLButtonElement
    expect(option).not.toBeNull()

    fireEvent.click(option)
    expect(setRunnerCalls).toHaveLength(0)
  })

  test("switching from opencode to claude-acp is blocked when locked", () => {
    const { container } = render(() => <AgentRunnerSelector sessionLocked={true} />)

    for (const runner of ["claude-acp", "codex-acp", "cursor-acp", "pi", "opencode"]) {
      const opt = container.querySelector(`[data-testid='select-option-${runner}']`) as HTMLButtonElement
      fireEvent.click(opt)
    }
    expect(setRunnerCalls).toHaveLength(0)
  })

  test("all runner options are clickable when unlocked", () => {
    const { container } = render(() => <AgentRunnerSelector sessionLocked={false} />)

    for (const runner of ["claude-acp", "codex-acp", "cursor-acp", "pi", "opencode"]) {
      const opt = container.querySelector(`[data-testid='select-option-${runner}']`) as HTMLButtonElement
      fireEvent.click(opt)
    }
    expect(setRunnerCalls).toHaveLength(5)
    expect(setRunnerCalls.map((c) => c.type)).toEqual(["claude-acp", "codex-acp", "cursor-acp", "pi", "opencode"])
  })
})
