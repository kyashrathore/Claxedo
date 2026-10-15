import { expect, test } from "bun:test"
import { planModels, readPlanModels } from "./plan-models"

const PLAN = { baseURL: "https://chatgpt.example/backend-api/codex/", access: "plan-token", accountID: "acct-1" }

test("a plan offers the models its catalog lists, in the catalog's order, and none it hides", () => {
  expect(planModels({ models: [
    { slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra", visibility: "list", priority: 8, context_window: 272_000 },
    { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide", priority: 43 },
    { slug: "gpt-6-luna", display_name: "GPT-6-Luna", visibility: "list", priority: 4, context_window: 372_000 },
  ] })).toEqual([
    { id: "gpt-6-luna", name: "GPT-6-Luna", priority: 4, context: 372_000 },
    { id: "gpt-5.6-terra", name: "GPT-5.6-Terra", priority: 8, context: 272_000 },
  ])
})

test("the catalog is read from the plan's Codex backend with its token and account", async () => {
  const seen: Request[] = []
  const models = await readPlanModels(PLAN, async (url, init) => {
    seen.push(new Request(url.href, init))
    return Response.json({ models: [{ slug: "gpt-6-luna", display_name: "GPT-6-Luna", visibility: "list", priority: 4 }] })
  })
  expect(models.map((model) => model.id)).toEqual(["gpt-6-luna"])
  expect(seen.map((request) => [request.url, request.headers.get("authorization"), request.headers.get("chatgpt-account-id")]))
    .toEqual([["https://chatgpt.example/backend-api/codex/models?client_version=0.159.2", "Bearer plan-token", "acct-1"]])
})

test.each([
  ["an edge's block page", () => new Response("<!DOCTYPE html><html></html>", { status: 403, headers: { "content-type": "text/html" } }), /answered 403 text\/html/],
  ["a catalog that lists nothing", () => Response.json({ models: [{ slug: "gpt-reserve", visibility: "hide", priority: 1 }] }), /the plan lists none/],
  ["an answer that is no catalog", () => Response.json({ detail: "nope" }), /lists no models/],
] as const)("%s leaves the plan unread with a credential error rather than a guessed list", async (_, answer, message) => {
  const failure = readPlanModels(PLAN, async () => answer())
  await expect(failure).rejects.toMatchObject({ code: "credential_unavailable" })
  await expect(failure).rejects.toThrow(message)
})
