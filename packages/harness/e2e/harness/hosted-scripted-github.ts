import type { IncomingMessage } from "node:http"

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
