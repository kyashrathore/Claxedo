import { expect, test } from "bun:test"
import { Hono } from "hono"
import { CredentialSelectionError } from "@claxedo/harness/registry"
import { harnessUnavailableResponse } from "./session-harness-refusal"

test("credential refusal retains its typed reason at the HTTP boundary", async () => {
  const app = new Hono().get("/", (c) => harnessUnavailableResponse(c,
    new CredentialSelectionError("account_unavailable", "No account for owner")) ?? c.text("unexpected"))
  const response = await app.request("http://localhost/")
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ error: {
    code: "account_unavailable", message: "No account for owner", details: { retryable: false },
  } })
})
