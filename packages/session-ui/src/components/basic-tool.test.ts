import { describe, expect, test } from "bun:test"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { hasRenderedContent, humanizeTool, type GenericToolTitle, collapsePayload } from "./basic-tool"

// Outside a provider `useI18n()` yields the shipped English catalog, so these
// assertions read the copy a user reads rather than a stand-in for it.
const i18n = useI18n()
const humanize = (tool: string, input?: Record<string, unknown>) => humanizeTool(tool, input, i18n)

describe("humanizeTool", () => {
  const CASES: Array<[name: string, tool: string, input: Record<string, unknown>, expected: GenericToolTitle]> = [
    [
      "an MCP tool keeps its server out of the title",
      "mcp__ccd_session_mgmt__list_sessions",
      { limit: 8 },
      { title: "List sessions", subtitle: undefined, context: "ccd session mgmt" },
    ],
    [
      "a repeated plugin/server pair collapses to one word of context",
      "mcp__plugin_posthog_posthog__exec",
      { command: 'call generate-app-url {"url": "/data-management/events"}', context: "Building a link" },
      {
        title: "Exec",
        subtitle: "call generate-app-url {…}",
        context: "plugin posthog",
      },
    ],
    [
      "a key that is its own preposition joins the action to its object",
      "sendmessage",
      { to: "catalog-lane", summary: "Pin the fixture", type: "message" },
      { title: "Send message to", subtitle: "catalog-lane", context: undefined },
    ],
    [
      "a one-token name resolves through the phrase table",
      "toolsearch",
      { query: "select:SendMessage", max_results: 1 },
      { title: "Search tools", subtitle: "select:SendMessage", context: undefined },
    ],
    [
      "an empty input still names the action",
      "listagents",
      {},
      { title: "List agents", subtitle: undefined, context: undefined },
    ],
    [
      "a snake_case name is read as words without a table entry",
      "create_pull_request",
      { description: "Fix the clip" },
      { title: "Create pull request", subtitle: "Fix the clip", context: undefined },
    ],
    [
      "an acronym keeps its case",
      "mcp__ccd__list_MCP_tools",
      {},
      { title: "List MCP tools", subtitle: undefined, context: "ccd" },
    ],
    [
      "a name with no words to recover and no object falls back to the raw call",
      "frobnicate",
      {},
      { title: "Called frobnicate", subtitle: undefined, context: undefined },
    ],
    [
      "the fallback still surfaces the object it did find",
      "frobnicate",
      { path: "packages/session-ui" },
      { title: "Called frobnicate", subtitle: "packages/session-ui", context: undefined },
    ],
  ]

  for (const [name, tool, input, expected] of CASES) {
    test(name, () => {
      expect(humanize(tool, input)).toEqual(expected)
    })
  }

  test("an absent input is the same as an empty one", () => {
    expect(humanize("listagents")).toEqual(humanize("listagents", {}))
  })
})

describe("collapsePayload", () => {
  test("collapses an embedded request body but keeps the command", () => {
    expect(collapsePayload('call generate-app-url {"url": "/data-management/events", "params": {}}')).toBe(
      "call generate-app-url {…}",
    )
  })

  test("collapses arrays and nested objects to a single marker", () => {
    expect(collapsePayload('post [{"a":{"b":1}},{"c":2}]')).toBe("post […]")
  })

  test("leaves prose without a payload untouched", () => {
    expect(collapsePayload("Fix merge fallout in claxedo-app")).toBe("Fix merge fallout in claxedo-app")
  })

  test("leaves an unbalanced brace alone rather than mangling it", () => {
    expect(collapsePayload("awk '{print $1}' | grep {")).toBe("awk '{print $1}' | grep {")
  })

  test("collapses each balanced run independently", () => {
    expect(collapsePayload('a {"x":1} b {"y":2} c')).toBe("a {…} b {…} c")
  })
})

describe("hasRenderedContent", () => {
  test("a child that resolved to nothing is not content", () => {
    expect(hasRenderedContent(undefined)).toBe(false)
    expect(hasRenderedContent(null)).toBe(false)
    expect(hasRenderedContent(false)).toBe(false)
    expect(hasRenderedContent("")).toBe(false)
    expect(hasRenderedContent("   ")).toBe(false)
  })

  test("a list of children that all resolved to nothing is not content either", () => {
    expect(hasRenderedContent([])).toBe(false)
    expect(hasRenderedContent([undefined, null, false])).toBe(false)
  })

  test("anything that reaches the screen is content", () => {
    expect(hasRenderedContent("output")).toBe(true)
    expect(hasRenderedContent(0)).toBe(true)
    expect(hasRenderedContent([undefined, "output"])).toBe(true)
  })
})
