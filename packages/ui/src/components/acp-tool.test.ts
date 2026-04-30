import { describe, expect, it } from "bun:test"
import {
  describeAcpArgs,
  describeAcpSubtitle,
  readAcpBody,
  readAcpChildSessionId,
  readAcpDiffs,
  readAcpLinks,
  readAcpTool,
  resolveAcpTool,
} from "./acp-tool"

describe("acp tool helpers", () => {
  // -------------------------------------------------------------------------
  // Card routing by intent and mode
  // -------------------------------------------------------------------------

  describe("card routing", () => {
    it("resolves shell intent to bash", () => {
      expect(resolveAcpTool("run", { intent: "shell", command: "git status" }, { acp: { intent: "shell" } })).toBe("bash")
    })

    it("resolves read intent with filePath to read", () => {
      expect(resolveAcpTool("read", { intent: "read", filePath: "/src/foo.ts" }, { acp: { intent: "read" } })).toBe("read")
    })

    it("resolves lint intent to a dedicated lint card", () => {
      expect(resolveAcpTool("lint", { intent: "lint", summary: "Read Lints" }, { acp: { intent: "lint" } })).toBe("acp:lint")
    })

    it("resolves list intent with glob mode to glob", () => {
      expect(resolveAcpTool("search", { intent: "list", mode: "glob", path: ".", pattern: "*.ts" }, { acp: { intent: "list", mode: "glob" } })).toBe("glob")
    })

    it("resolves list intent with path to list", () => {
      expect(resolveAcpTool("list", { intent: "list", path: "/src" }, { acp: { intent: "list" } })).toBe("list")
    })

    it("resolves search/web to websearch when query exists", () => {
      expect(resolveAcpTool("web", { intent: "search", mode: "web", query: "test" }, { acp: { intent: "search", mode: "web" } })).toBe("websearch")
    })

    it("resolves search/codebase to codesearch when query exists", () => {
      expect(resolveAcpTool("code", { intent: "search", mode: "codebase", query: "auth" }, { acp: { intent: "search", mode: "codebase" } })).toBe("codesearch")
    })

    it("resolves search with pattern and path to grep", () => {
      expect(resolveAcpTool("grep", { intent: "search", pattern: "TODO", path: "/src" }, { acp: { intent: "search" } })).toBe("grep")
    })

    it("resolves fetch with url to webfetch", () => {
      expect(resolveAcpTool("fetch", { intent: "fetch", url: "https://example.com" }, { acp: { intent: "fetch" } })).toBe("webfetch")
    })

    it("resolves task and todo ACP intents to native cards", () => {
      expect(resolveAcpTool("task", { intent: "task", description: "Subagent task" }, { acp: { intent: "task" } })).toBe("task")
      expect(resolveAcpTool("todowrite", { intent: "todos", summary: "Update TODOs" }, { acp: { intent: "todos" } })).toBe("todowrite")
    })

    it("resolves delete intent with filePath to acp:delete", () => {
      expect(resolveAcpTool("delete", { intent: "delete", filePath: "/src/old.ts" }, { acp: { intent: "delete" } })).toBe("acp:delete")
    })

    it("resolves mcp intent to acp:mcp", () => {
      expect(resolveAcpTool("mcp", { intent: "mcp" }, { acp: { intent: "mcp" } })).toBe("acp:mcp")
    })

    it("resolves image intent to acp:image", () => {
      expect(resolveAcpTool("img", { intent: "image" }, { acp: { intent: "image" } })).toBe("acp:image")
    })

    it("resolves computer intent to acp:computer", () => {
      expect(resolveAcpTool("comp", { intent: "computer" }, { acp: { intent: "computer" } })).toBe("acp:computer")
    })

    it("resolves edit/apply_patch with filePath to acp:apply-patch", () => {
      expect(resolveAcpTool("edit", { intent: "edit", mode: "apply_patch", filePath: "/src/a.ts" }, { acp: { intent: "edit", mode: "apply_patch" } })).toBe("acp:apply-patch")
    })

    it("resolves edit/write with filePath to acp:write", () => {
      expect(resolveAcpTool("write", { intent: "edit", mode: "write", filePath: "/src/new.ts" }, { acp: { intent: "edit", mode: "write" } })).toBe("acp:write")
    })

    it("resolves edit with filePath and hasDiff to native edit", () => {
      expect(resolveAcpTool("edit", { intent: "edit", filePath: "/src/a.ts" }, { acp: { intent: "edit", hasDiff: true } })).toBe("edit")
    })
  })

  // -------------------------------------------------------------------------
  // Sparse evidence → fallback routing
  // -------------------------------------------------------------------------

  describe("sparse evidence fallback", () => {
    it("keeps sparse web and code searches on their native ACP cards", () => {
      expect(resolveAcpTool("web", { intent: "search", mode: "web", summary: "Web Search" }, { acp: { intent: "search", mode: "web" } })).toBe("websearch")
      expect(resolveAcpTool("codebase", { intent: "search", mode: "codebase", summary: "Codebase Search" }, { acp: { intent: "search", mode: "codebase" } })).toBe("codesearch")
    })

    it("keeps sparse read on the native card but leaves unsupported sparse tools on fallback", () => {
      expect(resolveAcpTool("read", { intent: "read", summary: "Read File" }, { acp: { intent: "read" } })).toBe("read")
      expect(resolveAcpTool("grep", { intent: "search", summary: "grep" }, { acp: { intent: "search" } })).toBeUndefined()
      expect(resolveAcpTool("bash", { intent: "shell", summary: "Terminal" }, { acp: { intent: "shell" } })).toBe("bash")
    })

    it("keeps delete without filePath on fallback", () => {
      expect(resolveAcpTool("delete", { intent: "delete", summary: "Delete" }, { acp: { intent: "delete" } })).toBeUndefined()
    })

    it("keeps edit without filePath on fallback", () => {
      expect(resolveAcpTool("edit", { intent: "edit" }, { acp: { intent: "edit" } })).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // Metadata extraction
  // -------------------------------------------------------------------------

  describe("metadata extraction", () => {
    it("hydrates filePath from ACP locations", () => {
      const item = readAcpTool({ intent: "read" }, { acp: { intent: "read", locations: [{ path: "src/foo.ts", line: 3 }] } })
      expect(item).toMatchObject({ intent: "read", filePath: "src/foo.ts" })
    })

    it("hydrates rawName from rawToolName", () => {
      const item = readAcpTool({ intent: "shell" }, { acp: { intent: "shell", rawToolName: "Bash" } })
      expect(item?.rawName).toBe("Bash")
    })

    it("hydrates stats from rawOutput", () => {
      const item = readAcpTool(
        { intent: "list" },
        { acp: { intent: "list", rawOutput: { totalFiles: 42, truncated: true } } },
      )
      expect(item?.stats).toMatchObject({ totalFiles: 42, truncated: true })
    })

    it("returns undefined for non-ACP input", () => {
      expect(readAcpTool({}, {})).toBeUndefined()
    })

    it("reads ACP diffs from metadata patch and filediff shims", () => {
      const diffs = readAcpDiffs(
        { intent: "edit" },
        {
          filediff: { file: "/src/a.ts", before: "old", after: "new" },
          acp: {
            intent: "edit",
            patch: [{ filePath: "/src/b.ts", before: "", after: "new-b", type: "add" }],
          },
        },
      )
      expect(diffs).toHaveLength(2)
      expect(diffs[0]).toMatchObject({ filePath: "/src/a.ts", before: "old", after: "new" })
      expect(diffs[1]).toMatchObject({ filePath: "/src/b.ts", type: "add" })
    })

    it("reads child session ids from ACP metadata and raw payloads", () => {
      expect(readAcpChildSessionId({}, { sessionId: "child-1" })).toBe("child-1")
      expect(readAcpChildSessionId(
        {},
        { acp: { rawOutput: { child_session_id: "child-2" } } },
      )).toBe("child-2")
    })

    it("reads only valid links from ACP output evidence", () => {
      const links = readAcpLinks(
        { intent: "fetch" },
        {
          acp: {
            intent: "fetch",
            rawOutput: {
              url: "notaurl",
              results: [
                { url: "https://example.com/docs" },
                { uri: "https://example.com/api" },
              ],
            },
            body: "See https://example.com/extra and ignore not-a-link",
          },
        },
      )
      expect(links).toEqual([
        "https://example.com/docs",
        "https://example.com/api",
        "https://example.com/extra",
      ])
    })

    it("formats shell bodies with command context", () => {
      const item = readAcpTool(
        { intent: "shell", command: "pwd" },
        { acp: { intent: "shell", command: "pwd", rawOutput: { stdout: "\u001b[32m/workspace\u001b[39m\n" } } },
      )
      expect(readAcpBody(item!)).toBe("$ pwd\n\n/workspace")
    })

    it("keeps sparse shell on the native bash card without a fake prompt", () => {
      const item = readAcpTool(
        { intent: "shell", summary: "Terminal" },
        { acp: { intent: "shell", rawOutput: { stdout: "27\n", exitCode: 0 } } },
      )
      expect(item?.mode).toBe("result")
      expect(resolveAcpTool("bash", { intent: "shell", summary: "Terminal" }, { acp: { intent: "shell", rawOutput: { stdout: "27\n", exitCode: 0 } } })).toBe("bash")
      expect(readAcpBody(item!)).toBe("27")
    })

    it("parses JSON-string ACP output wrappers into visible body text", () => {
      const item = readAcpTool(
        { intent: "mcp" },
        {
          acp: {
            intent: "mcp",
            rawOutput: "{\"content\":[{\"type\":\"text\",\"text\":\"hello from mcp\"}],\"isError\":false}",
          },
        },
      )
      expect(readAcpBody(item!)).toBe("hello from mcp")
    })

    it("infers mcp intent from generic server-backed tools", () => {
      const item = readAcpTool(
        { intent: "generic", summary: "List MCP Resources" },
        {
          acp: {
            intent: "generic",
            rawToolName: "list_mcp_resources",
            rawInput: { server: "context7", name: "list_mcp_resources" },
          },
        },
      )
      expect(item?.intent).toBe("mcp")
      expect(resolveAcpTool("tool", { intent: "generic" }, {
        acp: {
          intent: "generic",
          rawToolName: "list_mcp_resources",
          rawInput: { server: "context7", name: "list_mcp_resources" },
        },
      })).toBe("acp:mcp")
    })

    it("drops invalid fetch urls and keeps query-backed searches honest", () => {
      const item = readAcpTool(
        { intent: "fetch", query: "weather: San Francisco, CA", url: "for: weather: San Francisco, CA" },
        { acp: { intent: "fetch" } },
      )
      expect(item?.intent).toBe("search")
      expect(item?.url).toBeUndefined()
      expect(resolveAcpTool("fetch", { intent: "fetch", query: "weather: San Francisco, CA", url: "for: weather: San Francisco, CA" }, { acp: { intent: "fetch" } })).toBe("websearch")
    })
  })

  // -------------------------------------------------------------------------
  // Subtitle and args
  // -------------------------------------------------------------------------

  describe("subtitle and args", () => {
    it("shell subtitle is the command", () => {
      const item = readAcpTool({ intent: "shell", command: "git push" }, { acp: { intent: "shell" } })
      expect(describeAcpSubtitle(item!)).toBe("git push")
    })

    it("shell subtitle is empty for bare Terminal", () => {
      const item = readAcpTool({ intent: "shell", summary: "Terminal" }, { acp: { intent: "shell" } })
      expect(describeAcpSubtitle(item!)).toBe("")
    })

    it("fetch subtitle is the URL", () => {
      const item = readAcpTool({ intent: "fetch", url: "https://example.com" }, { acp: { intent: "fetch" } })
      expect(describeAcpSubtitle(item!)).toBe("https://example.com")
    })

    it("search subtitle is the query", () => {
      const item = readAcpTool({ intent: "search", query: "TODO" }, { acp: { intent: "search" } })
      expect(describeAcpSubtitle(item!)).toBe("TODO")
    })

    it("list subtitle is the path", () => {
      const item = readAcpTool({ intent: "list", path: "/src" }, { acp: { intent: "list" } })
      expect(describeAcpSubtitle(item!)).toBe("/src")
    })

    it("delete subtitle is the file path", () => {
      const item = readAcpTool({ intent: "delete", filePath: "/src/old.ts" }, { acp: { intent: "delete" } })
      expect(describeAcpSubtitle(item!)).toBe("/src/old.ts")
    })

    it("mcp subtitle is server/tool", () => {
      const item = readAcpTool(
        { intent: "mcp" },
        { acp: { intent: "mcp", rawInput: { server: "myserver", tool: "mytool" } } },
      )
      expect(describeAcpSubtitle(item!)).toBe("myserver / mytool")
    })

    it("summarizes count-based ACP outputs as args instead of raw debug", () => {
      const item = readAcpTool(
        { intent: "list", mode: "files", summary: "Find" },
        { acp: { intent: "list", mode: "files", rawOutput: { totalFiles: 126, truncated: false } } },
      )
      expect(item).toBeDefined()
      expect(describeAcpSubtitle(item!)).toBe("Find")
      expect(describeAcpArgs(item!)).toEqual(["126 files", "mode=files"])
    })

    it("includes shell exit codes, diagnostics, and resource counts in args", () => {
      const shell = readAcpTool(
        { intent: "shell", summary: "Terminal" },
        { acp: { intent: "shell", rawOutput: { exitCode: 0 } } },
      )
      const read = readAcpTool(
        { intent: "read", summary: "Read Lints" },
        { acp: { intent: "read", rawOutput: { totalDiagnostics: 0, totalFiles: 0 } } },
      )
      const mcp = readAcpTool(
        { intent: "mcp", summary: "List MCP Resources" },
        { acp: { intent: "mcp", rawOutput: { resources: [] } } },
      )
      expect(describeAcpArgs(shell!)).toContain("exit=0")
      expect(describeAcpArgs(read!)).toEqual(["0 files", "0 diagnostics"])
      expect(describeAcpArgs(mcp!)).toContain("0 resources")
    })

    it("renders lint empty state honestly", () => {
      const item = readAcpTool(
        { intent: "lint", summary: "Read Lints" },
        { acp: { intent: "lint", rawOutput: { totalDiagnostics: 0, totalFiles: 0 } } },
      )
      expect(readAcpBody(item!)).toBe("No lint issues")
      expect(describeAcpArgs(item!)).toEqual(["0 files", "0 diagnostics"])
    })

    it("dedupes identical shell output from output and rawOutput", () => {
      const item = readAcpTool(
        { intent: "shell", command: 'find src -type f | wc -l' },
        { acp: { intent: "shell", rawOutput: { stdout: "384\n", exitCode: 0 } } },
      )
      expect(readAcpBody(item!, "384\n")).toBe("$ find src -type f | wc -l\n\n384")
    })

    it("totalMatches shows match count", () => {
      const item = readAcpTool(
        { intent: "search", pattern: "TODO", path: "/src" },
        { acp: { intent: "search", rawOutput: { totalMatches: 5, truncated: false } } },
      )
      expect(describeAcpArgs(item!)).toContain("5 matches")
      expect(describeAcpArgs(item!)).toContain("path=/src")
    })

    it("keeps sparse read cards on the fallback without fake file info", () => {
      const item = readAcpTool(
        { intent: "read", summary: "List MCP Resources" },
        { acp: { intent: "read", kind: "read", summary: "List MCP Resources" } },
      )
      expect(item).toBeDefined()
      expect(describeAcpSubtitle(item!)).toBe("List MCP Resources")
      expect(describeAcpArgs(item!)).toEqual([])
    })

    it("keeps opaque ids out of the main subtitle and args", () => {
      const item = readAcpTool(
        { intent: "generic", summary: "Called search" },
        {
          acp: {
            intent: "generic",
            rawInput: { call_id: "call_123", process_id: "proc_123" },
          },
        },
      )
      expect(item).toBeDefined()
      expect(describeAcpSubtitle(item!)).toBe("Called search")
      expect(describeAcpArgs(item!)).toEqual([])
    })

    it("no duplicate title and subtitle", () => {
      const item = readAcpTool(
        { intent: "generic", summary: "MyTool" },
        { acp: { intent: "generic", title: "MyTool", summary: "MyTool" } },
      )
      // subtitle should be the same as summary, but AcpFallbackTool deduplicates in trigger()
      // Here we just verify the subtitle value — dedup happens in the component
      expect(describeAcpSubtitle(item!)).toBe("MyTool")
    })

    it("delete args include filename", () => {
      const item = readAcpTool(
        { intent: "delete", filePath: "/src/old.ts" },
        { acp: { intent: "delete" } },
      )
      expect(describeAcpArgs(item!)).toContain("old.ts")
    })
  })

  // -------------------------------------------------------------------------
  // Negative rendering tests
  // -------------------------------------------------------------------------

  describe("negative rendering", () => {
    it("missing filePath never renders fabricated path", () => {
      const item = readAcpTool(
        { intent: "read" },
        { acp: { intent: "read" } },
      )
      expect(item?.filePath).toBeUndefined()
    })

    it("missing command never renders fabricated command", () => {
      const item = readAcpTool(
        { intent: "shell" },
        { acp: { intent: "shell" } },
      )
      expect(item?.command).toBeUndefined()
    })

    it("missing url never renders fabricated url", () => {
      const item = readAcpTool(
        { intent: "fetch" },
        { acp: { intent: "fetch" } },
      )
      expect(item?.url).toBeUndefined()
    })

    it("missing query never renders fabricated query", () => {
      const item = readAcpTool(
        { intent: "search" },
        { acp: { intent: "search" } },
      )
      expect(item?.query).toBeUndefined()
    })

    it("reads search query aliases from ACP raw input", () => {
      const item = readAcpTool(
        { intent: "search" },
        { acp: { intent: "search", rawInput: { searchQuery: "bun install" } } },
      )
      expect(item?.query).toBe("bun install")
    })

    it("missing pattern never renders fabricated pattern", () => {
      const item = readAcpTool(
        { intent: "search" },
        { acp: { intent: "search" } },
      )
      expect(item?.pattern).toBeUndefined()
    })
  })
})
