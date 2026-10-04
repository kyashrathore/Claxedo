import type { IncomingMessage } from "node:http"
import { gitHubArchiveFetch } from "../../../claxedo-server-core/src/agent-plugins/sources/github-archive-fixture"
import { HOSTED_MCP_RESOURCE } from "./hosted-scripted-mcp"

export const HOSTED_PLUGIN_REPOSITORY = { owner: "hosted-e2e", repository: "plugins", ref: "main" } as const
export const HOSTED_PLUGIN_NAME = "hosted-proof"
export const HOSTED_PLUGIN_MISSING_COMMAND = "h28-missing-command"

/**
 * The plugin collection the hosted flows register as a source: one plugin
 * whose HTTP server sits behind the scripted OAuth upstream and whose local
 * command the sandbox image does not ship.
 */
const collection = gitHubArchiveFetch({
  repository: HOSTED_PLUGIN_REPOSITORY.repository,
  files: {
    [`${HOSTED_PLUGIN_NAME}/plugin.json`]: JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: HOSTED_PLUGIN_NAME, version: "1.0.0" }),
    [`${HOSTED_PLUGIN_NAME}/mcp.json`]: JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        scripted: { type: "streamable-http", url: HOSTED_MCP_RESOURCE },
        local: { type: "stdio", command: HOSTED_PLUGIN_MISSING_COMMAND },
      },
    }),
    [`${HOSTED_PLUGIN_NAME}/skills/proof/SKILL.md`]: "---\nname: proof\ndescription: Calls the hosted proof tool\n---\n\nUse the proof tool.\n",
  },
})

export async function scriptedGithub(request: IncomingMessage, url: URL): Promise<Response | undefined> {
  if (url.origin === "https://github.com" && url.pathname === "/login/oauth/access_token") {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const code = new URLSearchParams(Buffer.concat(chunks).toString()).get("code")
    if (code !== "hosted-person-a" && code !== "hosted-person-b") {
      return Response.json({ error: "bad_verification_code" }, { status: 400 })
    }
    return Response.json({ access_token: `hosted-token-${code}`, token_type: "bearer", scope: "read:user user:email" })
  }
  const repository = `/${HOSTED_PLUGIN_REPOSITORY.owner}/${HOSTED_PLUGIN_REPOSITORY.repository}/`
  if ((url.origin === "https://api.github.com" && url.pathname.startsWith(`/repos${repository}commits/`))
    || (url.origin === "https://codeload.github.com" && url.pathname.startsWith(`${repository}zip/`))) {
    return collection.fetch(url.toString())
  }
  if (url.origin !== "https://api.github.com" || (url.pathname !== "/user" && url.pathname !== "/user/emails")) return undefined
  const person = request.headers.authorization?.replace(/^Bearer /i, "")
  if (person !== "hosted-token-hosted-person-a" && person !== "hosted-token-hosted-person-b") {
    return Response.json({ message: "unauthorized" }, { status: 401 })
  }
  const id = person.endsWith("-a") ? 101 : 202
  const email = `hosted-person-${id}@example.test`
  if (url.pathname === "/user") {
    return Response.json({ id, login: `hosted-person-${id}`, name: `Hosted Person ${id}`, email, avatar_url: `https://example.test/avatar/${id}` })
  }
  return Response.json([{ email, primary: true, verified: true, visibility: "public" }])
}
