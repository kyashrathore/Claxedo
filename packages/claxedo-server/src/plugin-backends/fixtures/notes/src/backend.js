import { DurableObject } from "cloudflare:workers"
import { definePluginBackend, PluginPlatformError } from "@claxedo/plugin-api/backend"

export class Notes extends DurableObject {
  async fetch(request) {
    this.ctx.storage.sql.exec("create table if not exists notes (text text not null)")
    if (request.method === "POST") this.ctx.storage.sql.exec("insert into notes (text) values (?)", await request.text())
    return Response.json(this.ctx.storage.sql.exec("select text from notes").toArray().map((row) => row.text))
  }
}

const notes = (platform, init) => platform.object("Notes", "main", new Request("https://plugin.invalid/notes", init))

const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] })

async function startedOrRefused(platform, projectId) {
  try {
    return await platform.sessions.start({
      origin: { scope: projectId, key: "note-1" },
      projectId,
      placement: "local",
      configuration: { harness: { id: "codex", access: "native" }, model: { providerID: "openai", modelID: "gpt-5" }, effort: null },
      digest: "d".repeat(64),
    })
  } catch (error) {
    if (error instanceof PluginPlatformError) return { refused: error.code }
    throw error
  }
}

export default definePluginBackend({
  fetch: async (_request, platform) => notes(platform),
  async tool(name, args, platform) {
    if (name === "note_add") return text(await (await notes(platform, { method: "POST", body: String(args.text) })).json())
    if (name === "note_list") return text({ notes: await (await notes(platform)).json(), caller: await platform.identity.caller() })
    if (name === "note_dump") return text("x".repeat(300 * 1024))
    if (name === "note_spawn") return text(await startedOrRefused(platform, String(args.projectId)))
    return { content: [{ type: "text", text: `no tool ${name}` }], isError: true }
  },
})
