import { test, expect } from "@playwright/test"

const BACKEND = process.env.PLAYWRIGHT_BACKEND_URL ?? "http://localhost:3001"
const DIR = process.env.PLAYWRIGHT_WORKSPACE_DIR ?? "/Users/yashvardhansingh/test/opencode"
const LIVE = process.env.SMOKE_TEST === "1"

type Chunk = Record<string, unknown>

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function stream(url: string, body: unknown, ms = 90_000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "x-opencode-directory": DIR,
    },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  })
  if (!res.ok || !res.body) {
    clearTimeout(timer)
    throw new Error(`HTTP ${res.status} from ${url}`)
  }

  const chunks: Chunk[] = []
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const parts = buf.split("\n\n")
      buf = parts.pop() ?? ""
      for (const part of parts) {
        const line = part.split("\n").find((item) => item.startsWith("data: "))
        const json = line?.slice(6).trim()
        if (!json) continue
        const chunk = JSON.parse(json) as Chunk
        chunks.push(chunk)
        if (chunk.type === "finish" || chunk.type === "error") return chunks
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") throw err
  } finally {
    clearTimeout(timer)
    reader.cancel().catch(() => {})
  }
  return chunks
}

test.describe("Live agent smoke", () => {
  test.skip(!LIVE, "Set SMOKE_TEST=1 with claxedo-server/workspace-runtime credentials to run live agent smoke tests")

  test("provider and runner endpoints expose the ACP runner contract", async () => {
    const provider = await fetch(`${BACKEND}/provider`)
    expect(provider.ok).toBe(true)
    const body = (await provider.json()) as {
      all: Array<{ id: string; models: Record<string, { providerID?: string }> }>
      default: Record<string, string>
    }
    const ids = body.all.map((item) => item.id)
    expect(ids).not.toContain("anthropic")
    expect(ids).not.toContain("openai")
    expect(ids.some((id) => id === "claude-acp" || id === "codex-acp")).toBe(true)

    const runner = await fetch(`${BACKEND}/api/claxedo/agent-config/runner`)
    expect(runner.ok).toBe(true)
    const cfg = (await runner.json()) as { type?: string }
    expect(["claude-acp", "codex-acp", "opencode"]).toContain(cfg.type)
  })

  test("persists a sent message and renders it after navigation", async ({ page }) => {
    const created = await fetch(`${BACKEND}/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-opencode-directory": DIR,
      },
      body: JSON.stringify({ title: "playwright-live-agent-smoke" }),
    })
    expect(created.status).toBe(201)
    const session = (await created.json()) as { id: string }
    const id = `msg_${Date.now().toString(16)}`
    const chunks = await stream(`${BACKEND}/session/${session.id}/message`, {
      parts: [{ type: "text", text: "Say only the word: ZXQTEST_RESPONSE" }],
      messageID: id,
    })
    expect(chunks.some((chunk) => chunk.type === "finish")).toBe(true)

    const messages = await fetch(`${BACKEND}/session/${session.id}/message`, {
      headers: { "x-opencode-directory": DIR },
    })
    expect(messages.ok).toBe(true)
    const data = (await messages.json()) as Array<{
      info?: { role: string; id: string; parentID?: string }
      parts?: Array<{ type: string; text?: string }>
    }>
    expect(data.some((item) => item.info?.role === "user")).toBe(true)
    expect(data.some((item) => item.info?.role === "assistant")).toBe(true)
    expect(data.find((item) => item.info?.role === "assistant")?.info?.parentID).toBe(id)

    await page.goto(`/${slug(DIR)}/session/${session.id}`)
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("ZXQTEST_RESPONSE").first()).toBeVisible({ timeout: 30_000 })
  })
})
