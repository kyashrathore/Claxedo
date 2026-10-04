import fs from "node:fs/promises"
import { request } from "node:https"
import type { LookupFunction } from "node:net"
import type { startHostedStack } from "./hosted-stack"
import { observeHttp } from "./wire-corpus"

type HostedStack = Awaited<ReturnType<typeof startHostedStack>>
export type HostedPerson = { id: string; email: string; cookie: string }

/** Every fixture listener binds 127.0.0.1, while the OS resolves a *.localhost name to ::1 first. */
const fixtureLoopback: LookupFunction = (_hostname, options, callback) => {
  if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }])
  else callback(null, "127.0.0.1", 4)
}

export async function hostedFetch(
  stack: HostedStack,
  route: string,
  options: RequestInit = {},
  person?: HostedPerson,
) {
  const ca = await fs.readFile(stack.certificate, "utf8")
  const headers = new Headers(options.headers)
  if (options.method && options.method !== "GET") headers.set("origin", stack.workerUrl)
  if (person) headers.set("cookie", person.cookie)
  // Under Bun's node:https a request on a reused keep-alive socket to workerd
  // intermittently fails with ECONNRESET, so each request takes its own.
  headers.set("connection", "close")
  // node:https frames a body only for methods it chunks by default, which DELETE is not.
  if (typeof options.body === "string") headers.set("content-length", String(Buffer.byteLength(options.body)))
  const url = new URL(route, stack.workerUrl)
  const reply = await new Promise<Response>((resolve, reject) => {
    const upstream = request(url, {
      method: options.method ?? "GET", headers: Object.fromEntries(headers), ca, signal: options.signal ?? undefined,
      lookup: fixtureLoopback,
    }, (received) => {
      const responseHeaders = new Headers()
      for (let index = 0; index < received.rawHeaders.length; index += 2) responseHeaders.append(received.rawHeaders[index], received.rawHeaders[index + 1])
      const chunks: Buffer[] = []
      received.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
      received.on("error", reject)
      received.on("end", () => {
        const status = received.statusCode ?? 502
        resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: responseHeaders }))
      })
    })
    upstream.on("error", reject)
    upstream.end(options.body as string | undefined)
  })
  await observeHttp(url, options.method ?? "GET", headers.get("accept"), reply)
  return reply
}

export async function signInHostedPerson(stack: HostedStack, code: "hosted-person-a" | "hosted-person-b") {
  const started = await hostedFetch(stack, "/api/auth/sign-in/social", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "github", callbackURL: `${stack.workerUrl}/after-login` }),
  })
  if (!started.ok) throw new Error(`hosted GitHub sign-in start failed: ${started.status} ${await started.text()}`)
  const payload = await started.json() as { url: string }
  const authorize = new URL(payload.url)
  if (authorize.origin !== "https://github.com" || authorize.pathname !== "/login/oauth/authorize") {
    throw new Error(`hosted sign-in returned unexpected authorize URL: ${authorize}`)
  }
  const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "")
  if (callback.origin !== stack.workerUrl || callback.pathname !== "/api/auth/callback/github") {
    throw new Error(`hosted sign-in returned unexpected callback: ${callback}`)
  }
  callback.searchParams.set("state", authorize.searchParams.get("state") ?? "")
  callback.searchParams.set("code", code)
  const stateCookie = started.headers.get("set-cookie")?.split(";")[0]
  if (!stateCookie) throw new Error("hosted sign-in issued no state cookie")
  const completed = await hostedFetch(stack, callback.toString(), { headers: { cookie: stateCookie } })
  const sessionCookie = /__Secure-claxedo\.session_token=[^;]+/.exec(completed.headers.get("set-cookie") ?? "")?.[0]
  if (completed.status !== 302 || !sessionCookie) {
    throw new Error(`hosted GitHub callback failed: ${completed.status} ${await completed.text()}`)
  }
  const session = await hostedFetch(stack, "/api/auth/get-session", { headers: { cookie: sessionCookie } })
  const sessionBody = await session.json() as { user?: { id?: string; email?: string } }
  if (!session.ok || !sessionBody.user?.id || !sessionBody.user.email) throw new Error(`hosted GitHub session missing: ${JSON.stringify(sessionBody)}`)
  return { id: sessionBody.user.id, email: sessionBody.user.email, cookie: sessionCookie } satisfies HostedPerson
}

/** The owner invites `invitee` over the public route; the token is the one the Worker's `EMAIL` binding sent. */
export async function inviteHostedPerson(stack: HostedStack, owner: HostedPerson, invitee: HostedPerson, orgId: string) {
  const created = await hostedFetch(stack, `/api/control/orgs/${encodeURIComponent(orgId)}/invitations`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: invitee.email, role: "member" }),
  }, owner)
  if (created.status !== 202) throw new Error(`hosted invitation creation failed: ${created.status} ${await created.text()}`)
  return new URL(await stack.recordedEmailActionUrl(invitee.email, "Join your Claxedo organization")).hash.slice(1)
}
