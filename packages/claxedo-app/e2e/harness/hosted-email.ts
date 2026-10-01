import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { hostedFetch } from "../../../harness/e2e/harness/hosted-auth"
import { hostedControlTransport, type HostedStack } from "../../../harness/e2e/harness/hosted-flow"
import type { AuthEmailMessage } from "../../../claxedo-server/src/platform/auth/better-auth-configuration"

export async function signUpHostedEmail(stack: HostedStack, name: string) {
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, ".")}@claxedo.test`
  const password = `pw-${randomUUID()}`
  const signup = await hostedFetch(stack, "/api/auth/sign-up/email", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email, password }),
  })
  if (!signup.ok) throw new Error(`Hosted email signup failed: ${signup.status} ${await signup.text()}`)
  const { user } = await signup.json() as { user: { id: string } }
  let verification: AuthEmailMessage | undefined
  for (let attempt = 0; attempt < 40; attempt++) {
    const messages = await fs.readFile(path.join(stack.root, "auth-email.jsonl"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
      return ""
    })
    verification = messages.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as AuthEmailMessage)
      .find((message) => message.kind === "verification" && message.recipient === email)
    if (verification) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!verification) throw new Error(`Hosted email verification was not delivered for ${email}`)
  const verified = await hostedFetch(stack, verification.actionUrl)
  if (verified.status !== 302 && !verified.ok) throw new Error(`Hosted email verification failed: ${verified.status}`)
  const signin = await hostedFetch(stack, "/api/auth/sign-in/email", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }),
  })
  const cookie = /__Secure-claxedo\.session_token=[^;]+/.exec(signin.headers.get("set-cookie") ?? "")?.[0]
  if (!signin.ok || !cookie) throw new Error(`Hosted email sign-in failed: ${signin.status} ${await signin.text()}`)
  const person = { id: user.id, cookie }
  return { name, email, password, subject: user.id, person, transport: hostedControlTransport(stack, person) }
}
