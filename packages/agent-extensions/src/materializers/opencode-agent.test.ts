import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { generateOpenCodeDocAgentMarkdown, materializeOpenCodeDocAgent, OPENCODE_DOC_AGENT_FILE } from "./opencode-agent"

const root = path.join(os.tmpdir(), `opencode-agent-materializer-${randomUUID().slice(0, 8)}`)

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe("OpenCode doc agent materializer", () => {
  test("writes the built-in doc agent profile", async () => {
    const agentDir = path.join(root, "agent")

    const result = await materializeOpenCodeDocAgent({ agentDir, force: true })

    expect(result.status).toBe("applied")
    await expect(fs.readFile(path.join(agentDir, OPENCODE_DOC_AGENT_FILE), "utf8")).resolves.toBe(generateOpenCodeDocAgentMarkdown())
  })
})
