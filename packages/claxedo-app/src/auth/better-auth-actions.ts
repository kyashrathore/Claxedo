import type { BrowserAuthSignInOptions, BrowserAuthSignUpOptions } from "./browser-auth"
import { callbackUrl, clientResult } from "./better-auth-client"
import { endSession, hydrateSession, reloadDescriptor, selectedMethod, type BetterAuthSession } from "./better-auth-session"

function assertAvailable(session: BetterAuthSession) {
  const reason = session.state.unavailable()
  if (reason) throw new Error(reason)
}

async function leaveForProvider(session: BetterAuthSession, provider: "google" | "github", callbackURL: string, live: Promise<unknown>) {
  const [, started] = await Promise.all([live, clientResult("sign-in", session.connected().client.signIn.social({ provider, callbackURL, disableRedirect: true }))])
  selectedMethod(session, provider)
  const url = started?.url
  if (typeof url !== "string" || new URL(url).protocol !== "https:") throw new Error("Better Auth sign-in returned no provider address")
  session.leave(url)
}

export async function signIn(session: BetterAuthSession, options?: BrowserAuthSignInOptions) {
  assertAvailable(session)
  const { client, origin } = session.connected()
  const redirect = callbackUrl(options?.redirectUrl, origin)
  const offered = session.state.descriptor()?.methods ?? []
  const requested = options?.method ?? (offered.length === 1 ? offered[0] : undefined)
  if ((requested === "google" || requested === "github") && offered.includes(requested)) {
    await leaveForProvider(session, requested, redirect, reloadDescriptor(session))
    return
  }
  await reloadDescriptor(session)
  const method = selectedMethod(session, options?.method)
  if (method === "google" || method === "github") {
    await leaveForProvider(session, method, redirect, Promise.resolve())
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
  const { client, origin } = session.connected()
  await clientResult("sign-up", client.signUp.email({
    email: options.email,
    password: options.password,
    name: options.name?.trim() || options.email,
    callbackURL: callbackUrl(options.redirectUrl, origin),
  }))
  await hydrateSession(session)
}

export async function signOut(session: BetterAuthSession) {
  try {
    if (!session.state.unavailable()) await clientResult("sign-out", session.connected().client.signOut())
  } finally {
    endSession(session)
  }
}
