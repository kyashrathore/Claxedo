/// <reference types="bun" />
import { expect, onTestFinished, test } from "bun:test"
import { createWorkspaceServer, FIXTURE_PLACEMENT } from "@/lib/test-workspace-server"
import { ServerError } from "@/server"
import { createSuggestions } from "./suggestions"
import { slashCommandBadge } from "./view/slash-command-row"

function serveCommands(body: unknown) {
  const workspace = createWorkspaceServer({})
  onTestFinished(workspace.dispose)
  const served = globalThis.fetch
  const requested: URL[] = []
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.pathname !== "/api/wr/command") return served(input, init)
    requested.push(url)
    return Response.json(body)
  }, { preconnect: served.preconnect })
  return { workspace, requested, commands: () => workspace.server.queries.harnesses.commands(FIXTURE_PLACEMENT, "claude") }
}

test("slash picker: a harness's saved and transport commands list with their origin and source badges", async () => {
  const fixture = serveCommands([
    { name: "review", origin: "saved", content: "Review my saved instructions" },
    { name: "review", origin: "transport", description: "Harness review", input: { hint: "<path>" } },
    { name: "deploy", origin: "transport", description: "Ship it", source: "skill" },
    { name: "linear", origin: "transport", source: "mcp" },
    { name: "compact", origin: "transport", source: "command" },
  ])
  const suggestions = fixture.workspace.mount(() => createSuggestions({
    registries: { mentions: { list: () => [], add: () => () => undefined } },
    commandOptions: () => [{ id: "session.new", title: "New session", slash: "new" }],
    placementId: () => FIXTURE_PLACEMENT,
    harness: () => "claude",
    query: () => ({ kind: "slash", query: "" }),
  }))
  await fixture.workspace.server.queryClient.fetchQuery(fixture.commands())
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(fixture.requested.map((url) => url.searchParams.get("nativeHarness"))).toEqual(["claude"])
  expect(suggestions.slashItems().map((item) => ({ id: item.id, description: item.description, badge: slashCommandBadge(item) }))).toEqual([
    { id: "custom.saved.review", description: undefined, badge: "prompt.slash.badge.saved" },
    { id: "custom.transport.review", description: "Harness review · <path>", badge: "prompt.slash.badge.custom" },
    { id: "custom.transport.deploy", description: "Ship it", badge: "prompt.slash.badge.skill" },
    { id: "custom.transport.linear", description: undefined, badge: "prompt.slash.badge.mcp" },
    { id: "custom.transport.compact", description: undefined, badge: undefined },
    { id: "session.new", description: undefined, badge: undefined },
  ])
  expect(suggestions.slashItems()[0]).toMatchObject({ type: "custom", origin: "saved", content: "Review my saved instructions" })
})

test("slash picker: a saved command without its content fails the command read", async () => {
  const fixture = serveCommands([{ name: "triage", origin: "saved" }])
  const read = fixture.workspace.server.queryClient.fetchQuery(fixture.commands())
  await expect(read).rejects.toBeInstanceOf(ServerError)
  await expect(read).rejects.toThrow("The harness command list answer does not match its contract")
})
