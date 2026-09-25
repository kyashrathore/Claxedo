import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import { refreshCodexChatgptTokens } from "./auth"

test("Codex refresh returns protocol fields and persists the rotated owner token", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-refresh-"))
  try {
    await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ tokens: {
      access_token: "old-access", refresh_token: "old-refresh", account_id: "account-1",
    } }))
    let calls = 0
    const request = async (_url: string, init: RequestInit) => {
      calls++
      expect(init?.body).toContain("refresh_token=old-refresh")
      return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh" }), { status: 200 })
    }
    expect(await refreshCodexChatgptTokens(home, request)).toEqual({ accessToken: "new-access", chatgptAccountId: "account-1", chatgptPlanType: null })
    expect(calls).toBe(1)
    const auth = JSON.parse(await fs.readFile(path.join(home, "auth.json"), "utf8"))
    expect(auth.tokens).toMatchObject({ access_token: "new-access", refresh_token: "new-refresh", account_id: "account-1" })
  } finally { await fs.rm(home, { recursive: true, force: true }) }
})
