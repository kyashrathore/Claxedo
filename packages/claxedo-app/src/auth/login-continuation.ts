import { toAppError, type Server } from "@/server"
import { invitationMachine } from "./model"
import type { BrowserAuthSignInOptions } from "./browser-auth"
import type { Auth } from "./store"

const REAUTHENTICATION_PROMPTS = new Set(["login", "create"])

export type LoginOAuthContinuation = {
  readonly signInRedirect: string
  readonly authorizationUrl: string
  readonly requiresFreshSignIn: boolean
}

function promptsOf(query: URLSearchParams) {
  return (query.get("prompt") ?? "").split(" ").filter(Boolean)
}

function requiresFreshSignIn(query: URLSearchParams) {
  return query.has("max_age") || promptsOf(query).some((prompt) => REAUTHENTICATION_PROMPTS.has(prompt))
}

function satisfiedAuthorizationSearch(search: string, query: URLSearchParams) {
  if (!requiresFreshSignIn(query)) return search
  const satisfied = new URLSearchParams(query)
  const remaining = promptsOf(query).filter((prompt) => !REAUTHENTICATION_PROMPTS.has(prompt))
  if (remaining.length) satisfied.set("prompt", remaining.join(" "))
  else satisfied.delete("prompt")
  satisfied.delete("max_age")
  return `?${satisfied.toString()}`
}

export function loginOAuthContinuation(input: {
  origin: string
  pathname: string
  search: string
}): LoginOAuthContinuation | undefined {
  if (input.pathname !== "/login" || !input.search) return undefined
  const query = new URLSearchParams(input.search)
  if (
    query.get("response_type") !== "code" ||
    !query.get("client_id") ||
    !query.get("redirect_uri") ||
    !query.get("state")
  ) return undefined

  const login = new URL(input.pathname, input.origin)
  login.search = input.search
  const authorize = new URL("/api/auth/oauth2/authorize", input.origin)
  authorize.search = satisfiedAuthorizationSearch(input.search, query)
  return {
    signInRedirect: `${login.pathname}${login.search}`,
    authorizationUrl: authorize.toString(),
    requiresFreshSignIn: requiresFreshSignIn(query),
  }
}

const AUTHORIZATION_SIGN_IN_KEY = "claxedo:authorization:signInStarted"

export function markAuthorizationSignInStarted(continuation: LoginOAuthContinuation) {
  try {
    sessionStorage.setItem(AUTHORIZATION_SIGN_IN_KEY, continuation.authorizationUrl)
  } catch (error) {
    console.warn("This tab could not record the sign-in it started for an app, so returning here asks to sign in again", { error })
  }
}

export function takeAuthorizationSignInStarted(continuation: LoginOAuthContinuation): boolean {
  try {
    const started = sessionStorage.getItem(AUTHORIZATION_SIGN_IN_KEY)
    sessionStorage.removeItem(AUTHORIZATION_SIGN_IN_KEY)
    return started === continuation.authorizationUrl
  } catch (error) {
    console.warn("This tab could not read the sign-in it started for an app, so it asks to sign in again", { error })
    return false
  }
}

export function loginDestination(continuation: { authorizationUrl: string } | undefined): { assign: string } | { navigate: string } {
  return continuation ? { assign: continuation.authorizationUrl } : { navigate: "/" }
}

function invitationAcceptance(
  auth: Pick<Auth, "state">,
  acceptInvitation: Server["acceptOrgInvitation"],
  token: string,
) {
  const state = invitationMachine()
  let pending: Promise<unknown> | undefined
  const accept = () => {
    if (auth.state().kind !== "signedIn") return Promise.resolve(undefined)
    const current = state.state()
    if (current.kind === "joined") return Promise.resolve(current.result)
    if (pending) return pending
    state.send({ type: "acceptanceStarted" })
    pending = acceptInvitation(token)
      .then((result) => {
        state.send({ type: "accepted", result })
        return result
      })
      .catch((cause: unknown) => {
        state.send({ type: "failed", failure: toAppError(cause) })
        throw cause
      })
      .finally(() => {
        pending = undefined
      })
    return pending
  }
  return { ...state, accept }
}

const INVITATION_STARTED_KEY = "claxedo:invitation:started"

function markInvitationStarted(token: string) {
  try {
    sessionStorage.setItem(INVITATION_STARTED_KEY, token)
  } catch (error) {
    console.warn("This tab could not record the invitation it is signing in for, so returning here asks before joining", { error })
  }
}

function takeInvitationStarted(token: string): boolean {
  try {
    const started = sessionStorage.getItem(INVITATION_STARTED_KEY)
    sessionStorage.removeItem(INVITATION_STARTED_KEY)
    return started === token
  } catch (error) {
    console.warn("This tab could not read the invitation it was signing in for, so it asks before joining", { error })
    return false
  }
}

export function createOrgInvitationFlow(
  auth: Pick<Auth, "state" | "signIn" | "signUp">,
  acceptInvitation: Server["acceptOrgInvitation"],
  token: string,
) {
  const acceptance = invitationAcceptance(auth, acceptInvitation, token)
  return {
    state: acceptance.state,
    accept: acceptance.accept,
    resume: () => (takeInvitationStarted(token) ? acceptance.accept() : Promise.resolve(undefined)),
    async authenticate(options: BrowserAuthSignInOptions, action: "signIn" | "signUp") {
      acceptance.send({ type: "authenticationStarted" })
      markInvitationStarted(token)
      try {
        await auth[action]({ ...options, redirectUrl: `/invitations#${encodeURIComponent(token)}` })
        if (auth.state().kind !== "signedIn") acceptance.send({ type: "authenticationPending" })
        return await acceptance.accept()
      } catch (cause) {
        acceptance.send({ type: "failed", failure: toAppError(cause) })
        throw cause
      }
    },
  }
}
