import type { BrowserAuthSignInOptions, BrowserAuthSignUpOptions } from "./browser-auth"
import { callbackUrl, clientResult } from "./better-auth-client"
import { endSession, hydrateSession, reloadDescriptor, selectedMethod, type BetterAuthSession } from "./better-auth-session"

function assertAvailable(session: BetterAuthSession) {
  const reason = session.state.unavailable()
  if (reason) throw new Error(reason)
}

export async function signIn(session: BetterAuthSession, options?: BrowserAuthSignInOptions) {
  assertAvailable(session)
  await reloadDescriptor(session)
  const method = selectedMethod(session, options?.method)
  const { client, origins } = session.connected()
  const redirect = callbackUrl(options?.redirectUrl, origins.appOrigin)
  if (method !== "email-password") {
    await clientResult("sign-in", client.signIn.social({ provider: method, callbackURL: redirect }))
    return
  }
  const credentials = options?.method === "email-password" ? options : { email: "", password: "" }
  await clientResult("sign-in", client.signIn.email({ email: credentials.email, password: credentials.password, callbackURL: redirect }))
  await hydrateSession(session)
}

export async function signUp(session: BetterAuthSession, options?: BrowserAuthSignUpOptions) {
  assertAvailable(session)
  const method = selectedMethod(session, options?.method)
  if (method !== "email-password" || options?.method !== "email-password") {
    if (method !== "google" && method !== "github") throw new Error(`Better Auth cannot run ${method}`)
    await signIn(session, { method, redirectUrl: options?.redirectUrl })
    return
  }
  await reloadDescriptor(session)
  const { client, origins } = session.connected()
  await clientResult("sign-up", client.signUp.email({
    email: options.email,
    password: options.password,
    name: options.name?.trim() || options.email,
    callbackURL: callbackUrl(options.redirectUrl, origins.appOrigin),
  }))
  await hydrateSession(session)
}

export async function signOut(session: BetterAuthSession) {
  if (!session.state.unavailable()) await clientResult("sign-out", session.connected().client.signOut())
  endSession(session)
}
