import type { ToolIntent } from "../../contracts/agent-runtime-event"
import type { ToolKind } from "./types"

export type AcpClient = "cursor-acp" | "codex-acp" | "claude-acp" | "unknown"
export type AcpIntent = ToolIntent

export type AcpRule = {
  client: AcpClient
  titles?: string[]
  names?: string[]
  kinds?: ToolKind[]
  short: string
  intent: AcpIntent
  mode?: string
  extractor: string
  evidence: string[]
}

export const ACP_TOOL_REGISTRY: AcpRule[] = [
  {
    client: "cursor-acp",
    titles: ["Terminal"],
    kinds: ["execute"],
    short: "bash",
    intent: "shell",
    extractor: "cursor-shell",
    evidence: ["rawOutput.stdout", "rawOutput.stderr", "content.terminalId"],
  },
  {
    client: "cursor-acp",
    titles: ["Read Lints"],
    short: "lint",
    intent: "lint",
    extractor: "cursor-lints",
    evidence: ["rawOutput.totalDiagnostics", "rawOutput.totalFiles"],
  },
  {
    client: "cursor-acp",
    titles: ["Read File"],
    kinds: ["read"],
    short: "read",
    intent: "read",
    extractor: "cursor-read",
    evidence: ["rawOutput.content", "locations", "content.path"],
  },
  {
    client: "cursor-acp",
    titles: ["Edit File"],
    kinds: ["edit"],
    short: "edit",
    intent: "edit",
    extractor: "cursor-edit",
    evidence: ["content.path", "diff.path", "rawOutput.content"],
  },
  {
    client: "cursor-acp",
    titles: ["Delete File"],
    kinds: ["delete"],
    short: "delete",
    intent: "delete",
    extractor: "cursor-delete",
    evidence: ["content.path", "diff.path"],
  },
  {
    client: "cursor-acp",
    titles: ["Find"],
    kinds: ["search"],
    short: "find",
    intent: "list",
    mode: "files",
    extractor: "cursor-find",
    evidence: ["rawOutput.totalFiles", "rawInput.parsed_cmd"],
  },
  {
    client: "cursor-acp",
    titles: ["grep"],
    kinds: ["search"],
    short: "grep",
    intent: "search",
    mode: "content",
    extractor: "cursor-grep",
    evidence: ["rawOutput.totalMatches", "rawInput.parsed_cmd"],
  },
  {
    client: "cursor-acp",
    titles: ["Web Search"],
    kinds: ["search"],
    short: "websearch",
    intent: "search",
    mode: "web",
    extractor: "cursor-web",
    evidence: ["rawOutput.referenceCount", "rawInput.query"],
  },
  {
    client: "cursor-acp",
    titles: ["Codebase Search"],
    kinds: ["search"],
    short: "codesearch",
    intent: "search",
    mode: "codebase",
    extractor: "cursor-codebase",
    evidence: ["rawOutput.resultCount", "rawInput.query"],
  },
  // Cursor: MCP families (tool calls, resource listing, resource fetching)
  {
    client: "cursor-acp",
    titles: ["MCP Tool"],
    short: "mcp",
    intent: "mcp",
    mode: "tool",
    extractor: "cursor-mcp-tool",
    evidence: ["rawInput.server", "rawInput.tool"],
  },
  {
    client: "cursor-acp",
    titles: ["List MCP Resources"],
    short: "mcp",
    intent: "mcp",
    mode: "list",
    extractor: "cursor-mcp-list",
    evidence: ["rawInput.server", "rawOutput.resources"],
  },
  {
    client: "cursor-acp",
    titles: ["Fetch MCP Resource"],
    short: "mcp",
    intent: "mcp",
    mode: "fetch",
    extractor: "cursor-mcp-fetch",
    evidence: ["rawInput.server", "rawInput.uri"],
  },
  {
    client: "cursor-acp",
    titles: ["Task: Subagent task"],
    names: ["task"],
    short: "task",
    intent: "task",
    extractor: "cursor-task",
    evidence: ["rawInput.description", "title"],
  },
  {
    client: "cursor-acp",
    titles: ["Update TODOs"],
    names: ["updatetodos"],
    short: "todowrite",
    intent: "todos",
    extractor: "cursor-todos",
    evidence: ["rawInput._toolName"],
  },
  // Cursor: question/permission family (matched by name/title, NOT by think kind — think defaults to reasoning)
  {
    client: "cursor-acp",
    names: ["askquestion", "askuser"],
    titles: ["Ask Question", "Ask User", "Question"],
    short: "question",
    intent: "question",
    extractor: "cursor-question",
    evidence: ["rawInput.prompt", "rawInput.options"],
  },
  // Cursor: image family
  {
    client: "cursor-acp",
    titles: ["Generate Image"],
    short: "image",
    intent: "image",
    extractor: "cursor-image",
    evidence: ["rawInput.prompt", "rawOutput"],
  },
  // Cursor: create plan extension. Keep as task-shaped metadata until the UI has a dedicated plan surface.
  {
    client: "cursor-acp",
    titles: ["Create Plan"],
    names: ["createplan", "create_plan"],
    short: "plan",
    intent: "task",
    mode: "plan",
    extractor: "cursor-create-plan",
    evidence: ["rawInput.plan", "rawInput.phases", "rawOutput.planUri"],
  },
  // Cursor: computer-use family
  {
    client: "cursor-acp",
    titles: ["Computer Use"],
    short: "computer",
    intent: "computer",
    extractor: "cursor-computer",
    evidence: ["rawInput.action", "rawOutput"],
  },
  {
    client: "codex-acp",
    kinds: ["execute"],
    short: "bash",
    intent: "shell",
    extractor: "codex-shell",
    evidence: ["rawInput.command", "rawInput.parsed_cmd", "title"],
  },
  {
    client: "codex-acp",
    kinds: ["read"],
    short: "read",
    intent: "read",
    extractor: "codex-read",
    evidence: ["rawInput.filePath", "locations", "title"],
  },
  {
    client: "codex-acp",
    kinds: ["edit"],
    short: "edit",
    intent: "edit",
    extractor: "codex-edit",
    evidence: ["rawInput.filePath", "content.path", "diff.path"],
  },
  {
    client: "codex-acp",
    kinds: ["search"],
    short: "grep",
    intent: "search",
    extractor: "codex-search",
    evidence: ["rawInput.parsed_cmd", "rawInput.query", "title"],
  },
  {
    client: "codex-acp",
    names: ["find"],
    short: "find",
    intent: "list",
    mode: "files",
    extractor: "codex-find",
    evidence: ["rawInput.queries", "title"],
  },
  {
    client: "codex-acp",
    kinds: ["fetch"],
    short: "fetch",
    intent: "fetch",
    extractor: "codex-fetch",
    evidence: ["rawInput.url", "title"],
  },
  // Codex: apply_patch (multi-file edit)
  {
    client: "codex-acp",
    names: ["apply_patch"],
    short: "apply_patch",
    intent: "edit",
    mode: "apply_patch",
    extractor: "codex-apply-patch",
    evidence: ["rawInput.filePath", "content.path", "diff.path"],
  },
  // Codex: list files
  {
    client: "codex-acp",
    names: ["listfiles"],
    short: "list",
    intent: "list",
    mode: "list",
    extractor: "codex-list",
    evidence: ["rawInput.path", "title"],
  },
  // Codex: web search
  {
    client: "codex-acp",
    names: ["codesearch"],
    short: "codesearch",
    intent: "search",
    mode: "codebase",
    extractor: "codex-codesearch",
    evidence: ["rawInput.query", "title"],
  },
  {
    client: "codex-acp",
    names: ["websearch"],
    short: "websearch",
    intent: "search",
    mode: "web",
    extractor: "codex-websearch",
    evidence: ["rawInput.query", "rawInput.queries"],
  },
  // Codex: web fetch / open page
  {
    client: "codex-acp",
    names: ["openpage"],
    short: "webfetch",
    intent: "fetch",
    mode: "web",
    extractor: "codex-webfetch",
    evidence: ["rawInput.url"],
  },
  // Codex: permission request
  {
    client: "codex-acp",
    names: ["permission"],
    titles: ["Permission"],
    short: "question",
    intent: "question",
    mode: "permission",
    extractor: "codex-permission",
    evidence: ["rawInput.reason", "rawInput.scopes"],
  },
  // Codex: MCP tool
  {
    client: "codex-acp",
    names: ["mcp", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"],
    short: "mcp",
    intent: "mcp",
    mode: "tool",
    extractor: "codex-mcp",
    evidence: ["rawInput.server", "rawInput.tool"],
  },
  // Codex: delete
  {
    client: "codex-acp",
    kinds: ["delete"],
    short: "delete",
    intent: "delete",
    extractor: "codex-delete",
    evidence: ["rawInput.filePath", "title"],
  },
  // Claude ACP — keyed by toolName (strongest discriminator)
  {
    client: "claude-acp",
    names: ["bash"],
    titles: ["Terminal"],
    kinds: ["execute"],
    short: "bash",
    intent: "shell",
    extractor: "claude-shell",
    evidence: ["rawInput.command", "rawOutput.stdout", "content.terminalId"],
  },
  {
    client: "claude-acp",
    names: ["read"],
    titles: ["Read File"],
    kinds: ["read"],
    short: "read",
    intent: "read",
    extractor: "claude-read",
    evidence: ["rawInput.filePath", "locations", "rawOutput.content"],
  },
  {
    client: "claude-acp",
    names: ["write"],
    titles: ["Write"],
    short: "write",
    intent: "edit",
    mode: "write",
    extractor: "claude-write",
    evidence: ["rawInput.filePath", "content.path"],
  },
  {
    client: "claude-acp",
    names: ["edit"],
    titles: ["Edit File"],
    kinds: ["edit"],
    short: "edit",
    intent: "edit",
    mode: "edit",
    extractor: "claude-edit",
    evidence: ["rawInput.filePath", "content.path", "diff.path"],
  },
  {
    client: "claude-acp",
    names: ["glob"],
    titles: ["Find"],
    short: "glob",
    intent: "list",
    mode: "glob",
    extractor: "claude-glob",
    evidence: ["rawInput.pattern", "rawInput.path"],
  },
  {
    client: "claude-acp",
    names: ["grep"],
    short: "grep",
    intent: "search",
    mode: "grep",
    extractor: "claude-grep",
    evidence: ["rawInput.pattern", "rawInput.path"],
  },
  {
    client: "claude-acp",
    names: ["webfetch"],
    titles: ["Fetch"],
    kinds: ["fetch"],
    short: "webfetch",
    intent: "fetch",
    mode: "web",
    extractor: "claude-webfetch",
    evidence: ["rawInput.url"],
  },
  {
    client: "claude-acp",
    names: ["websearch"],
    titles: ["Web Search"],
    short: "websearch",
    intent: "search",
    mode: "web",
    extractor: "claude-websearch",
    evidence: ["rawInput.query"],
  },
  {
    client: "claude-acp",
    names: ["todowrite"],
    titles: ["Update TODOs"],
    short: "todowrite",
    intent: "todos",
    extractor: "claude-todos",
    evidence: ["rawInput.todos"],
  },
  {
    client: "claude-acp",
    names: ["exitplanmode"],
    short: "plan",
    intent: "reasoning",
    mode: "switch",
    extractor: "claude-plan",
    evidence: ["title"],
  },
  {
    client: "claude-acp",
    names: ["agent", "task"],
    titles: ["Task"],
    short: "task",
    intent: "task",
    extractor: "claude-task",
    evidence: ["rawInput.description", "title"],
  },
  {
    client: "claude-acp",
    names: ["toolsearch"],
    titles: ["ToolSearch"],
    kinds: ["other"],
    short: "other",
    intent: "generic",
    extractor: "claude-generic",
    evidence: ["title", "rawInput"],
  },
  {
    client: "claude-acp",
    titles: ["Skill", "LSP", "CronCreate", "CronList", "CronDelete"],
    kinds: ["other"],
    short: "other",
    intent: "generic",
    extractor: "claude-generic",
    evidence: ["title", "rawInput"],
  },
]

export function acpClient(value?: string): AcpClient {
  if (value === "cursor-acp") return value
  if (value === "codex-acp") return value
  if (value === "claude-acp") return value
  return "unknown"
}

export function findAcpRule(client: AcpClient, title?: string, name?: string, kind?: ToolKind) {
  const text = title?.trim().toLowerCase()
  const call = name?.trim().toLowerCase()
  const candidates = ACP_TOOL_REGISTRY.filter((item) => item.client === client)

  // 1. Provider-native tool name (highest precedence)
  if (call) {
    const match = candidates.find((item) => item.names?.some((row) => row.toLowerCase() === call))
    if (match) return match
  }

  // 2. Title match
  if (text) {
    const match = candidates.find((item) => item.titles?.some((row) => row.toLowerCase() === text))
    if (match) return match
  }

  // 3. Kind match (lowest precedence)
  if (kind) {
    const match = candidates.find((item) => item.kinds?.includes(kind))
    if (match) return match
  }

  return undefined
}
