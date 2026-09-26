import fs from "node:fs/promises"
import path from "node:path"

const SCRIPTED_CATALOG = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    models: {
      "claude-sonnet-4-5": { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", attachment: true, reasoning: true, tool_call: true, limit: { context: 200000, output: 64000 } },
    },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    models: {
      "gpt-4.1": { id: "gpt-4.1", name: "GPT-4.1", attachment: true, reasoning: false, tool_call: true, limit: { context: 1047576, output: 32768 } },
    },
  },
}

export async function writeScriptedModelCatalog(dataDir: string) {
  const file = path.join(dataDir, "opencode-model-catalog.json")
  await fs.writeFile(file, JSON.stringify({ at: Date.now(), body: SCRIPTED_CATALOG }))
  return file
}
