import { describe, expect, it } from "bun:test"
import { findAcpRule } from "./acp-registry"

describe("acp registry", () => {
  it("maps cursor todos tools by raw name", () => {
    const item = findAcpRule("cursor-acp", "Update TODOs", "updatetodos")
    expect(item).toMatchObject({ extractor: "cursor-todos", intent: "todos", short: "todowrite" })
  })

  it("maps codex execute tools by kind", () => {
    const item = findAcpRule("codex-acp", "Run git status", undefined, "execute")
    expect(item).toMatchObject({ extractor: "codex-shell", intent: "shell", short: "bash" })
  })

  it("maps claude ToolSearch to generic handling", () => {
    const item = findAcpRule("claude-acp", "ToolSearch", undefined, "other")
    expect(item).toMatchObject({ extractor: "claude-generic", intent: "generic" })
  })

  // -------------------------------------------------------------------------
  // Think kind conflict: question vs reasoning
  // -------------------------------------------------------------------------

  it("cursor think kind does NOT match question rule (defaults to reasoning via intent fallback)", () => {
    // kind=think without a question-family name/title → no registry match
    const item = findAcpRule("cursor-acp", "Thinking", undefined, "think")
    // No cursor rule matches think kind anymore — question is name/title-matched
    expect(item).toBeUndefined()
  })

  it("cursor askQuestion name matches question rule", () => {
    const item = findAcpRule("cursor-acp", undefined, "askQuestion")
    expect(item).toMatchObject({ intent: "question", extractor: "cursor-question" })
  })

  it("cursor Ask Question title matches question rule", () => {
    const item = findAcpRule("cursor-acp", "Ask Question")
    expect(item).toMatchObject({ intent: "question", extractor: "cursor-question" })
  })

  // -------------------------------------------------------------------------
  // Precedence: name > title > kind
  // -------------------------------------------------------------------------

  it("name takes precedence over kind for Claude WebSearch", () => {
    // WebSearch has kind=fetch but toolName=websearch → intent=search/web
    const item = findAcpRule("claude-acp", "Web Search", "websearch", "fetch")
    expect(item).toMatchObject({ intent: "search", mode: "web" })
  })

  it("Claude TodoWrite matched by name, not kind", () => {
    const item = findAcpRule("claude-acp", "Update TODOs", "todowrite", "think")
    expect(item).toMatchObject({ intent: "todos", extractor: "claude-todos" })
  })

  it("Codex permission matched by name", () => {
    const item = findAcpRule("codex-acp", "Permission", "permission")
    expect(item).toMatchObject({ intent: "question", mode: "permission" })
  })

  it("Claude ExitPlanMode matched by name", () => {
    const item = findAcpRule("claude-acp", "ExitPlanMode", "exitplanmode")
    expect(item).toMatchObject({ intent: "reasoning", mode: "switch" })
  })

  // -------------------------------------------------------------------------
  // MCP resource families → intent=mcp
  // -------------------------------------------------------------------------

  it("cursor List MCP Resources → intent=mcp, mode=list", () => {
    const item = findAcpRule("cursor-acp", "List MCP Resources", undefined, "read")
    expect(item).toMatchObject({ intent: "mcp", mode: "list", extractor: "cursor-mcp-list" })
  })

  it("cursor Fetch MCP Resource → intent=mcp, mode=fetch", () => {
    const item = findAcpRule("cursor-acp", "Fetch MCP Resource", undefined, "fetch")
    expect(item).toMatchObject({ intent: "mcp", mode: "fetch", extractor: "cursor-mcp-fetch" })
  })

  it("cursor MCP Tool → intent=mcp, mode=tool", () => {
    const item = findAcpRule("cursor-acp", "MCP Tool")
    expect(item).toMatchObject({ intent: "mcp", mode: "tool", extractor: "cursor-mcp-tool" })
  })

  it("cursor Read File still matches read, not mcp", () => {
    const item = findAcpRule("cursor-acp", "Read File", undefined, "read")
    expect(item).toMatchObject({ intent: "read", extractor: "cursor-read" })
  })
})
