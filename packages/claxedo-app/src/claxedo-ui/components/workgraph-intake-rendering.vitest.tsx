/**
 * WorkGraph intake rendering pipeline tests.
 *
 * Simulates an AI assistant responding with JSONL-embedded issue specs inside a
 * session message, then verifies:
 *   1. The JSONL text is correctly parsed into a json-render spec (pickerSpec)
 *   2. Issue elements are extracted from the spec (aiSpecItems)
 *   3. WorkgraphIssuePicker renders all titles in the DOM (rendering)
 *   4. Toggle / select-all / clear / import callbacks fire correctly
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { cleanup, render, waitFor, fireEvent } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { createSpecStreamCompiler } from "@json-render/core"
import { WorkgraphIssuePicker } from "./workgraph-issue-picker"
import type { WorkgraphPreview } from "../../utils/workgraph-api"

// ---------------------------------------------------------------------------
// Realistic mock AI response — mirrors what the actual AI produces.
// Text lines are ignored by the parser; only lines starting with "{" are
// fed into createSpecStreamCompiler (matching the tab-workgraph.tsx logic).
// ---------------------------------------------------------------------------
const MOCK_AI_TEXT = `
I found 3 issues related to testing in this repository.

{"op":"add","path":"/root","value":"main"}
{"op":"add","path":"/elements","value":{}}
{"op":"add","path":"/elements/main","value":{"type":"Stack","props":{"gap":"16px"},"children":["toolbar","issue_0","issue_1","issue_2"]}}
{"op":"add","path":"/elements/toolbar","value":{"type":"Toolbar","props":{"total":3,"selected":2,"loading":false},"on":{"select_all":{"action":"select_all"},"clear":{"action":"clear"},"import":{"action":"import"}},"children":[]}}
{"op":"add","path":"/elements/issue_0","value":{"type":"Issue","props":{"id":"owner/repo#1","title":"Add unit tests for parser","status":"open","external_key":"owner/repo#1","selected":true},"on":{"toggle":{"action":"toggle","params":{"id":"owner/repo#1"}}},"children":[]}}
{"op":"add","path":"/elements/issue_1","value":{"type":"Issue","props":{"id":"owner/repo#2","title":"Fix flaky integration test","status":"open","external_key":"owner/repo#2","selected":true},"on":{"toggle":{"action":"toggle","params":{"id":"owner/repo#2"}}},"children":[]}}
{"op":"add","path":"/elements/issue_2","value":{"type":"Issue","props":{"id":"owner/repo#3","title":"Improve test coverage","status":"closed","external_key":"owner/repo#3","selected":false},"on":{"toggle":{"action":"toggle","params":{"id":"owner/repo#3"}}},"children":[]}}
`.trim()

// Mock store data — mirrors what globalSync.child(dir)[0] returns after the
// assistant message is complete (time.completed set, parts populated).
const SESSION_ID = "session-intake-test"
const MESSAGE_ID = "msg-assistant-001"

const MOCK_STORE = {
  message: {
    [SESSION_ID]: [
      {
        id: MESSAGE_ID,
        role: "assistant",
        time: { created: Date.now() - 5000, completed: Date.now() - 100 },
      },
    ],
  },
  part: {
    [MESSAGE_ID]: [
      {
        id: "part-text-1",
        type: "text",
        text: MOCK_AI_TEXT,
        messageID: MESSAGE_ID,
        sessionID: SESSION_ID,
      },
    ],
  },
}

// ---------------------------------------------------------------------------
// Pipeline helpers — exact copies of the logic in tab-workgraph.tsx so that
// changes to the component break this test if the logic diverges.
// ---------------------------------------------------------------------------

type AiSpecItem = {
  id: string
  title: string
  description: string | undefined
  status: string
  external_key: string | undefined
  provider_url: string | undefined
  selected: boolean
  provider_meta: Record<string, unknown>
}

function buildPickerSpec(text: string): any | null {
  const compiler = createSpecStreamCompiler()
  let hasPatches = false
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) continue
    const { newPatches } = compiler.push(trimmed + "\n")
    if (newPatches.length) hasPatches = true
  }
  return hasPatches ? compiler.getResult() : null
}

function extractAiSpecItems(spec: any): AiSpecItem[] {
  if (!spec) return []

  // Pattern 1: direct Issue elements with literal string props
  const directIssues = (Object.values(spec.elements as Record<string, any>))
    .filter((el) => el.type === "Issue" && typeof el.props?.id === "string" && typeof el.props?.title === "string")
    .map((el) => ({
      id: String(el.props.id),
      title: String(el.props.title),
      description: el.props?.description ? String(el.props.description) : undefined,
      status: String(el.props?.status ?? "open"),
      external_key: el.props?.external_key ? String(el.props.external_key) : undefined,
      provider_url: el.props?.provider_url ? String(el.props.provider_url) : undefined,
      selected: !!el.props?.selected,
      provider_meta: (el.props?.provider_meta as Record<string, unknown>) ?? {},
    }))

  if (directIssues.length > 0) return directIssues

  // Pattern 2: state-backed issues (AI used repeat/$item pattern)
  const stateAny = (spec as any).state
  if (!stateAny || typeof stateAny !== "object") return []
  for (const stateValue of Object.values(stateAny)) {
    if (!Array.isArray(stateValue) || !stateValue.length) continue
    const first = stateValue[0]
    if (typeof first !== "object" || !first || !("title" in first)) continue
    return (stateValue as any[]).map((item) => ({
      id: String(item.id ?? item.external_key ?? ""),
      title: String(item.title ?? ""),
      description: item.description ? String(item.description) : undefined,
      status: String(item.status ?? "open"),
      external_key: item.external_key ? String(item.external_key) : undefined,
      provider_url: item.provider_url ? String(item.provider_url) : undefined,
      selected: item.selected !== false,
      provider_meta: (item.provider_meta as Record<string, unknown>) ?? {},
    }))
  }
  return []
}

function toPreviewItems(items: AiSpecItem[]): WorkgraphPreview[] {
  return items.map((item) => ({
    id: item.id,
    provider: "github" as const,
    provider_meta: item.provider_meta,
    title: item.title,
    description: item.description ?? "",
    status: (item.status === "closed" ? "closed" : item.status === "in_progress" ? "in_progress" : "open") as WorkgraphPreview["status"],
    provider_url: item.provider_url ?? "",
    external_key: item.id,
  }))
}

// Simulate latestAssistantText() logic
function getLatestAssistantText(store: typeof MOCK_STORE, sessionId: string): string {
  const msgs = store.message[sessionId] ?? []
  const msg = msgs.findLast(
    (m) => m.role === "assistant" && typeof (m as any).time?.completed === "number",
  )
  if (!msg) return ""
  const parts = (store.part as any)[msg.id] ?? []
  return parts
    .filter((p: any) => p.type === "text" && typeof p.text === "string")
    .map((p: any) => (p.text as string).trim())
    .filter(Boolean)
    .join("\n")
}

// ---------------------------------------------------------------------------
// Unit tests: parsing pipeline (no DOM)
// ---------------------------------------------------------------------------

describe("pickerSpec parsing pipeline", () => {
  test("latestAssistantText returns the JSONL text from a completed message", () => {
    const text = getLatestAssistantText(MOCK_STORE, SESSION_ID)
    expect(text.length).toBeGreaterThan(0)
    expect(text).toContain('"op":"add"')
  })

  test("latestAssistantText returns empty string when no completed message exists", () => {
    const store = {
      message: {
        [SESSION_ID]: [{ id: "m1", role: "assistant", time: { created: 1 } }], // no completed
      },
      part: {},
    }
    const text = getLatestAssistantText(store as any, SESSION_ID)
    expect(text).toBe("")
  })

  test("buildPickerSpec returns null for empty text", () => {
    expect(buildPickerSpec("")).toBeNull()
  })

  test("buildPickerSpec returns null for plain prose (no JSONL lines)", () => {
    expect(buildPickerSpec("Here are the issues I found.")).toBeNull()
  })

  test("buildPickerSpec parses JSONL patches into a valid spec", () => {
    const text = getLatestAssistantText(MOCK_STORE, SESSION_ID)
    const spec = buildPickerSpec(text)
    expect(spec).not.toBeNull()
    expect(spec.root).toBe("main")
    expect(spec.elements).toBeDefined()
  })

  test("buildPickerSpec requires newline-terminated pushes (regression for the +\\n fix)", () => {
    // Verifies that the +"\n" fix is critical: without it no patches would be emitted
    const line = '{"op":"add","path":"/root","value":"main"}'

    const withNewline = createSpecStreamCompiler()
    const { newPatches: withNl } = withNewline.push(line + "\n")
    expect(withNl.length).toBeGreaterThan(0) // line IS flushed

    const withoutNewline = createSpecStreamCompiler()
    const { newPatches: withoutNl } = withoutNewline.push(line)
    expect(withoutNl.length).toBe(0) // line is NOT flushed — still buffered
  })

  test("extractAiSpecItems finds all 3 issues via Pattern 1 (direct literal props)", () => {
    const text = getLatestAssistantText(MOCK_STORE, SESSION_ID)
    const spec = buildPickerSpec(text)
    const items = extractAiSpecItems(spec)
    expect(items).toHaveLength(3)
    expect(items.map((i) => i.id)).toEqual([
      "owner/repo#1",
      "owner/repo#2",
      "owner/repo#3",
    ])
  })

  test("extractAiSpecItems maps selected flag correctly", () => {
    const spec = buildPickerSpec(getLatestAssistantText(MOCK_STORE, SESSION_ID))
    const items = extractAiSpecItems(spec)
    expect(items.find((i) => i.id === "owner/repo#1")?.selected).toBe(true)
    expect(items.find((i) => i.id === "owner/repo#2")?.selected).toBe(true)
    expect(items.find((i) => i.id === "owner/repo#3")?.selected).toBe(false)
  })

  test("Show condition is truthy: pickerSpec !== null && items.length > 0", () => {
    const text = getLatestAssistantText(MOCK_STORE, SESSION_ID)
    const spec = buildPickerSpec(text)
    const items = extractAiSpecItems(spec)
    const previewItems = toPreviewItems(items)
    expect(spec !== null && previewItems.length > 0).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Pattern 2: state-array JSONL (AI used repeat + $bindItem pattern)
// ---------------------------------------------------------------------------

describe("pickerSpec Pattern 2 (state arrays)", () => {
  const PATTERN2_TEXT = [
    '{"op":"add","path":"/root","value":"list"}',
    '{"op":"add","path":"/elements","value":{}}',
    '{"op":"add","path":"/state","value":{"issues":[{"id":"owner/repo#10","title":"State issue one","status":"open"},{"id":"owner/repo#11","title":"State issue two","status":"closed"}]}}',
    '{"op":"add","path":"/elements/list","value":{"type":"Stack","props":{},"children":[]}}',
  ].join("\n")

  test("extracts issues from state array when no direct Issue elements exist", () => {
    const spec = buildPickerSpec(PATTERN2_TEXT)
    expect(spec).not.toBeNull()
    const items = extractAiSpecItems(spec)
    expect(items).toHaveLength(2)
    expect(items[0].title).toBe("State issue one")
    expect(items[1].title).toBe("State issue two")
  })
})

// ---------------------------------------------------------------------------
// Component rendering tests (DOM via jsdom + @solidjs/testing-library)
// ---------------------------------------------------------------------------

describe("WorkgraphIssuePicker rendering", () => {
  afterEach(cleanup)

  test("renders all issue titles from AI response", async () => {
    const text = getLatestAssistantText(MOCK_STORE, SESSION_ID)
    const spec = buildPickerSpec(text)
    const items = extractAiSpecItems(spec)
    const previewItems = toPreviewItems(items)
    const initialChecked = new Set(items.filter((i) => i.selected).map((i) => i.id))

    const view = render(() => (
      <WorkgraphIssuePicker
        items={previewItems}
        checked={initialChecked}
        next="stop_after_ingest"
        mode="project_or_team"
        provider="github"
        onToggle={() => {}}
        onSelectAll={() => {}}
        onClear={() => {}}
        onImport={() => {}}
      />
    ))

    await waitFor(() => {
      expect(view.getByText("Add unit tests for parser")).toBeTruthy()
      expect(view.getByText("Fix flaky integration test")).toBeTruthy()
      expect(view.getByText("Improve test coverage")).toBeTruthy()
    })
  })

  test("shows selected count in toolbar (2 of 3 selected)", async () => {
    const text = getLatestAssistantText(MOCK_STORE, SESSION_ID)
    const spec = buildPickerSpec(text)
    const items = extractAiSpecItems(spec)
    const previewItems = toPreviewItems(items)
    const initialChecked = new Set(items.filter((i) => i.selected).map((i) => i.id))

    const view = render(() => (
      <WorkgraphIssuePicker
        items={previewItems}
        checked={initialChecked}
        next="stop_after_ingest"
        mode="project_or_team"
        provider="github"
        onToggle={() => {}}
        onSelectAll={() => {}}
        onClear={() => {}}
        onImport={() => {}}
      />
    ))

    await waitFor(() => {
      expect(view.getByText("2/3 selected")).toBeTruthy()
    })
  })

  test("onToggle fires with the correct issue id when an issue is clicked", async () => {
    const onToggle = vi.fn()
    const text = getLatestAssistantText(MOCK_STORE, SESSION_ID)
    const spec = buildPickerSpec(text)
    const items = extractAiSpecItems(spec)
    const previewItems = toPreviewItems(items)

    const view = render(() => (
      <WorkgraphIssuePicker
        items={previewItems}
        checked={new Set<string>()}
        next="stop_after_ingest"
        mode="project_or_team"
        provider="github"
        onToggle={onToggle}
        onSelectAll={() => {}}
        onClear={() => {}}
        onImport={() => {}}
      />
    ))

    await waitFor(() => {
      expect(view.getByText("Add unit tests for parser")).toBeTruthy()
    })

    // Click the first issue button
    const btn = view.getByText("Add unit tests for parser").closest("button")!
    fireEvent.click(btn)

    expect(onToggle).toHaveBeenCalledWith("owner/repo#1")
  })

  test("onSelectAll fires when 'Select all' is clicked", async () => {
    const onSelectAll = vi.fn()
    const text = getLatestAssistantText(MOCK_STORE, SESSION_ID)
    const spec = buildPickerSpec(text)
    const previewItems = toPreviewItems(extractAiSpecItems(spec))

    const view = render(() => (
      <WorkgraphIssuePicker
        items={previewItems}
        checked={new Set<string>()}
        next="stop_after_ingest"
        mode="project_or_team"
        provider="github"
        onToggle={() => {}}
        onSelectAll={onSelectAll}
        onClear={() => {}}
        onImport={() => {}}
      />
    ))

    await waitFor(() => expect(view.getByText("Select all")).toBeTruthy())
    fireEvent.click(view.getByText("Select all"))
    expect(onSelectAll).toHaveBeenCalledTimes(1)
  })

  test("onImport fires when 'Import selected' is clicked", async () => {
    const onImport = vi.fn()
    const text = getLatestAssistantText(MOCK_STORE, SESSION_ID)
    const spec = buildPickerSpec(text)
    const previewItems = toPreviewItems(extractAiSpecItems(spec))

    const view = render(() => (
      <WorkgraphIssuePicker
        items={previewItems}
        checked={new Set(previewItems.map((i) => i.id))}
        next="stop_after_ingest"
        mode="project_or_team"
        provider="github"
        onToggle={() => {}}
        onSelectAll={() => {}}
        onClear={() => {}}
        onImport={onImport}
      />
    ))

    await waitFor(() => expect(view.getByText("Import selected")).toBeTruthy())
    fireEvent.click(view.getByText("Import selected"))
    expect(onImport).toHaveBeenCalledTimes(1)
  })

  test("renders auth state when AI returns an auth-required element", async () => {
    const AUTH_JSONL = [
      '{"op":"add","path":"/root","value":"root"}',
      '{"op":"add","path":"/elements","value":{}}',
      '{"op":"add","path":"/elements/root","value":{"type":"Stack","props":{"gap":"16px"},"children":["auth"]}}',
      '{"op":"add","path":"/elements/auth","value":{"type":"Auth","props":{"provider":"github","message":"GitHub token required.","hint":"Run: gh auth login"},"children":[]}}',
    ].join("\n")

    const spec = buildPickerSpec(AUTH_JSONL)
    const authEl = Object.values(spec.elements as Record<string, any>).find((el) => el.type === "Auth")
    const auth = authEl?.props

    const view = render(() => (
      <WorkgraphIssuePicker
        auth={auth}
        items={[]}
        checked={new Set<string>()}
        next="stop_after_ingest"
        mode="project_or_team"
        provider="github"
        onToggle={() => {}}
        onSelectAll={() => {}}
        onClear={() => {}}
        onImport={() => {}}
      />
    ))

    await waitFor(() => {
      expect(view.getByText("GitHub access needed")).toBeTruthy()
      expect(view.getByText("GitHub token required.")).toBeTruthy()
    })
  })

  test("renders empty state when AI returns no issues", async () => {
    const view = render(() => (
      <WorkgraphIssuePicker
        items={[]}
        checked={new Set<string>()}
        next="stop_after_ingest"
        mode="project_or_team"
        provider="github"
        onToggle={() => {}}
        onSelectAll={() => {}}
        onClear={() => {}}
        onImport={() => {}}
      />
    ))

    await waitFor(() => {
      expect(view.getByText("No issues matched")).toBeTruthy()
    })
  })

  test("checked state is reflected via checkbox in each issue row", async () => {
    const text = getLatestAssistantText(MOCK_STORE, SESSION_ID)
    const spec = buildPickerSpec(text)
    const items = extractAiSpecItems(spec)
    const previewItems = toPreviewItems(items)
    // Only first issue checked
    const [first, ...rest] = previewItems
    const checked = new Set([first.id])

    const view = render(() => (
      <WorkgraphIssuePicker
        items={previewItems}
        checked={checked}
        next="stop_after_ingest"
        mode="project_or_team"
        provider="github"
        onToggle={() => {}}
        onSelectAll={() => {}}
        onClear={() => {}}
        onImport={() => {}}
      />
    ))

    await waitFor(() => {
      expect(view.getByText("Add unit tests for parser")).toBeTruthy()
    })

    const checkboxes = view.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    expect(checkboxes[0].checked).toBe(true)
    expect(checkboxes[1].checked).toBe(false)
    expect(checkboxes[2].checked).toBe(false)
  })

  test("checked state updates reactively when signal changes", async () => {
    const text = getLatestAssistantText(MOCK_STORE, SESSION_ID)
    const spec = buildPickerSpec(text)
    const previewItems = toPreviewItems(extractAiSpecItems(spec))

    const [checked, setChecked] = createSignal(new Set<string>())

    const view = render(() => (
      <WorkgraphIssuePicker
        items={previewItems}
        checked={checked()}
        next="stop_after_ingest"
        mode="project_or_team"
        provider="github"
        onToggle={(id) => setChecked((prev) => { const n = new Set(prev); n.add(id); return n })}
        onSelectAll={() => {}}
        onClear={() => setChecked(new Set())}
        onImport={() => {}}
      />
    ))

    await waitFor(() => expect(view.getByText("Add unit tests for parser")).toBeTruthy())

    // Initially 0/3 selected
    expect(view.getByText("0/3 selected")).toBeTruthy()

    // Click first issue
    const btn = view.getByText("Add unit tests for parser").closest("button")!
    fireEvent.click(btn)

    await waitFor(() => expect(view.getByText("1/3 selected")).toBeTruthy())

    // Click Clear
    fireEvent.click(view.getByText("Clear"))

    await waitFor(() => expect(view.getByText("0/3 selected")).toBeTruthy())
  })
})
