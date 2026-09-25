import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { TurnInput } from "../../contract"
import { claudePrompt } from "./attachments"

const turn = (parts: TurnInput["prompt"]["parts"]): TurnInput => ({
  turnId: "t1", userMessageId: "u1", assistantMessageId: "a1", prompt: { agent: "claude", assistantMessageId: "a1", parts }, todos: [],
  origin: { actor: { kind: "machine-owner" }, via: "loopback", reissued: false },
})

test("images and PDFs reach the SDK as native blocks and private workspace files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-attachment-"))
  try {
    const input = turn([
      { type: "text", text: "Inspect these" },
      { type: "file", mime: "image/png", filename: "image.png", url: `data:image/png;base64,${Buffer.from("image").toString("base64")}` },
      { type: "file", mime: "application/pdf", filename: "paper.pdf", url: `data:application/pdf;base64,${Buffer.from("pdf").toString("base64")}` },
    ])
    const result = await claudePrompt(input, root)
    expect(result.message.content).toMatchObject([{ type: "image" }, { type: "document" }, { type: "text" }])
    const files = (await fs.readdir(path.join(root, ".claxedo", "attachments"))).filter((file) => file !== ".gitignore")
    expect(files).toHaveLength(2)
    expect(await fs.readFile(path.join(root, ".claxedo", "attachments", files.find((file) => file.endsWith("image.png"))!), "utf8")).toBe("image")
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test("a file URL the SDK cannot take is refused as configuration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-attachment-"))
  try {
    await expect(claudePrompt(turn([{ type: "file", mime: "image/png", url: "https://example.invalid/image.png" }]), root))
      .rejects.toMatchObject({ kind: "configuration" })
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test("turn system text stays out of the SDK user prompt", async () => {
  const result = await claudePrompt({ ...turn([{ type: "text", text: "user text" }]), system: "system only" }, os.tmpdir())
  expect(JSON.stringify(result.message.content)).toContain("user text")
  expect(JSON.stringify(result.message.content)).not.toContain("system only")
})
