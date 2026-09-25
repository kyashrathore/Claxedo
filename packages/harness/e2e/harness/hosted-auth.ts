import fs from "node:fs/promises"
import type { startHostedStack } from "./hosted-stack"

type HostedStack = Awaited<ReturnType<typeof startHostedStack>>
export type HostedPerson = { id: string; cookie: string }

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
  return fetch(new URL(route, stack.workerUrl), {
    ...options,
    redirect: options.redirect ?? "manual",
    headers,
    tls: { ca },
  } as RequestInit & { tls: { ca: string } })
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
  const sessionBody = await session.json() as { user?: { id?: string } }
  if (!session.ok || !sessionBody.user?.id) throw new Error(`hosted GitHub session missing: ${JSON.stringify(sessionBody)}`)
  return { id: sessionBody.user.id, cookie: sessionCookie } satisfies HostedPerson
}
