import { afterEach, describe, expect, test, vi } from "vitest"
import type { McpToolResult } from "../mcp-tool"
import type { McpToolContext } from "../context"
import { CLAXEDO_MCP_TOOL_GROUPS, claxedoMcpToolGroupInventory } from "./index"
import { registerYouSearchTools } from "./you-search"
import type { ToolRegistrar } from "./registry"

function captureRegistrar(): { registrar: ToolRegistrar; tools: Map<string, { handler: (args: Record<string, unknown>, ctx: McpToolContext) => Promise<McpToolResult> }> } {
	const tools = new Map<string, { handler: (args: Record<string, unknown>, ctx: McpToolContext) => Promise<McpToolResult> }>()
	const registrar: ToolRegistrar = {
		tool(name: string, _definition: unknown, handler: unknown) {
			tools.set(name, { handler: handler as (args: Record<string, unknown>, ctx: McpToolContext) => Promise<McpToolResult> })
		},
	}
	return { registrar, tools }
}

const mockCtx = { credential: { kind: "runtime", runtimeId: "rt", workspaceId: "ws", crossMachineWrites: false, readOnly: false }, client: {} as never, audit: () => undefined } as unknown as McpToolContext

afterEach(() => {
	vi.restoreAllMocks()
})

describe("you-search tool group", () => {
	test("is registered in CLAXEDO_MCP_TOOL_GROUPS", () => {
		expect(CLAXEDO_MCP_TOOL_GROUPS.some((g) => g.id === "you-search")).toBe(true)
	})

	test("has reach account (opt-in, off by default)", () => {
		const group = CLAXEDO_MCP_TOOL_GROUPS.find((g) => g.id === "you-search")
		expect(group?.reach).toBe("account")
	})

	test("appears in the group inventory", () => {
		const inventory = claxedoMcpToolGroupInventory()
		const group = inventory.find((g) => g.id === "you-search")
		expect(group).toBeDefined()
		expect(group?.tools).toContain("you_web_search")
	})

	test("registers a tool named you_web_search", () => {
		const { registrar, tools } = captureRegistrar()
		registerYouSearchTools(registrar)
		expect(tools.has("you_web_search")).toBe(true)
	})
})

describe("you_web_search handler", () => {
	test("returns formatted results on success", async () => {
		const { registrar, tools } = captureRegistrar()
		registerYouSearchTools(registrar)
		const handler = tools.get("you_web_search")!.handler

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						results: {
							web: [
								{ title: "Rust docs", url: "https://doc.rust-lang.org", description: "The Rust programming language" },
								{ title: "Rust homepage", url: "https://www.rust-lang.org" },
							],
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			),
		)

		const result = await handler({ query: "rust programming" }, mockCtx)
		expect(result.isError).toBeUndefined()
		expect(result.content[0].type).toBe("text")
		const text = (result.content[0] as { type: "text"; text: string }).text
		expect(text).toContain("Rust docs")
		expect(text).toContain("https://doc.rust-lang.org")
		expect(text).toContain("The Rust programming language")
		expect(text).toContain("Rust homepage")
	})

	test("returns an error on non-OK response", async () => {
		const { registrar, tools } = captureRegistrar()
		registerYouSearchTools(registrar)
		const handler = tools.get("you_web_search")!.handler

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 })),
		)

		const result = await handler({ query: "test" }, mockCtx)
		expect(result.isError).toBe(true)
		expect((result.content[0] as { type: "text"; text: string }).text).toContain("429")
	})

	test("returns no-results message when web array is empty", async () => {
		const { registrar, tools } = captureRegistrar()
		registerYouSearchTools(registrar)
		const handler = tools.get("you_web_search")!.handler

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ results: { web: [] } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			),
		)

		const result = await handler({ query: "test" }, mockCtx)
		expect(result.isError).toBeUndefined()
		expect((result.content[0] as { type: "text"; text: string }).text).toContain("No results")
	})

	test("returns an error on network failure", async () => {
		const { registrar, tools } = captureRegistrar()
		registerYouSearchTools(registrar)
		const handler = tools.get("you_web_search")!.handler

		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network error")))

		const result = await handler({ query: "test" }, mockCtx)
		expect(result.isError).toBe(true)
		expect((result.content[0] as { type: "text"; text: string }).text).toContain("network error")
	})

	test("limits results to the requested max_results", async () => {
		const { registrar, tools } = captureRegistrar()
		registerYouSearchTools(registrar)
		const handler = tools.get("you_web_search")!.handler

		const web = Array.from({ length: 8 }, (_, i) => ({ title: `Result ${i + 1}`, url: `https://example.com/${i + 1}` }))
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ results: { web } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			),
		)

		const result = await handler({ query: "test", max_results: 3 }, mockCtx)
		expect(result.isError).toBeUndefined()
		const text = (result.content[0] as { type: "text"; text: string }).text
		// Only 3 numbered entries should appear, not 8.
		expect(text.match(/^\d+\./gm)).toHaveLength(3)
		expect(text).toContain("Result 1")
		expect(text).toContain("Result 3")
		expect(text).not.toContain("Result 4")
	})

	test("returns an error when the response is missing results.web", async () => {
		const { registrar, tools } = captureRegistrar()
		registerYouSearchTools(registrar)
		const handler = tools.get("you_web_search")!.handler

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ unexpected: "shape" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			),
		)

		const result = await handler({ query: "test" }, mockCtx)
		expect(result.isError).toBe(true)
		expect((result.content[0] as { type: "text"; text: string }).text).toContain("unexpected response format")
	})

	test("passes an abort signal to fetch so stalled requests do not hang", async () => {
		const { registrar, tools } = captureRegistrar()
		registerYouSearchTools(registrar)
		const handler = tools.get("you_web_search")!.handler

		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ results: { web: [] } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		)
		vi.stubGlobal("fetch", fetchMock)

		await handler({ query: "test" }, mockCtx)
		const init = fetchMock.mock.calls[0][1] as RequestInit | undefined
		expect(init?.signal).toBeInstanceOf(AbortSignal)
	})

	test("marks the response as external untrusted content", async () => {
		const { registrar, tools } = captureRegistrar()
		registerYouSearchTools(registrar)
		const handler = tools.get("you_web_search")!.handler

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({ results: { web: [{ title: "Example", url: "https://example.com" }] } }),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			),
		)

		const result = await handler({ query: "test" }, mockCtx)
		const text = (result.content[0] as { type: "text"; text: string }).text
		expect(text.toLowerCase()).toContain("untrusted")
	})

	test("filters out results with missing or empty url", async () => {
		const { registrar, tools } = captureRegistrar()
		registerYouSearchTools(registrar)
		const handler = tools.get("you_web_search")!.handler

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						results: {
							web: [
								{ title: "Valid", url: "https://example.com/valid" },
								{ title: "No URL", url: "" },
								{ title: "Undefined URL" },
								{ title: "Also Valid", url: "https://example.com/also" },
							],
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			),
		)

		const result = await handler({ query: "test" }, mockCtx)
		const text = (result.content[0] as { type: "text"; text: string }).text
		expect(text).toContain("https://example.com/valid")
		expect(text).toContain("https://example.com/also")
		expect(text).not.toContain("No URL")
		expect(text).not.toContain("Undefined URL")
	})
})