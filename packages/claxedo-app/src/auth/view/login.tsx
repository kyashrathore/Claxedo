import { createEffect, createSignal, For, on, Show, type Accessor } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import { toAppError, useServer, type AppError } from "@/server"
import type { BrowserAuthMethod, BrowserAuthSignInOptions } from "../browser-auth"
import { createOrgInvitationFlow, loginOAuthContinuation } from "../login-continuation"
import { apiOrigin, appOrigin } from "../origins"
import { useAuth } from "../provider"
import { ClaxedoIcon as Icon } from "@/ui"
import { AuthSplit } from "./auth-split"
import "./auth.css"

const providerName = (method: "google" | "github") => (method === "google" ? "Google" : "GitHub")
type InvitationFlow = ReturnType<typeof createOrgInvitationFlow>
type LoginController = ReturnType<typeof createLoginController>

export function LoginPage() {
  return <LoginForm />
}

export function OrgInvitationPage() {
  const location = useLocation()
  return (
    <Show when={location.hash.slice(1)} keyed fallback={
      <main class="auth-page">
        <section class="auth-card">
          <h1 class="auth-title">Invitation link is incomplete</h1>
          <p class="auth-subtitle">Open the complete invitation link from your email, or ask your organization for a new invitation.</p>
          <a class="auth-button" href="/">Continue to Claxedo</a>
        </section>
      </main>
    }>
      {(token) => <LoginForm invitationToken={token} />}
    </Show>
  )
}

function loginRedirect() {
  const location = useLocation()
  const navigate = useNavigate()
  const continuation = () =>
    loginOAuthContinuation({
      appOrigin: appOrigin(),
      apiOrigin: apiOrigin(),
      pathname: location.pathname,
      search: location.search,
    })
  return {
    target: () => continuation()?.signInRedirect ?? "/",
    finish() {
      const destination = new URL(continuation()?.authorizationUrl ?? "/", appOrigin())
      if (destination.origin !== appOrigin()) window.location.assign(destination.toString())
      else navigate(`${destination.pathname}${destination.search}${destination.hash}`, { replace: true })
    },
  }
}

async function acceptInvitation(flow: InvitationFlow) {
  try {
    await flow.accept()
  } catch (cause) {
    console.error("Organization invitation acceptance failed", toAppError(cause).class)
  }
}

function loginAction(input: {
  auth: ReturnType<typeof useAuth>
  invitation?: InvitationFlow
  action: Accessor<"signIn" | "signUp">
  email: Accessor<string>
  password: Accessor<string>
  redirect: Accessor<string>
}) {
  const [failure, setFailure] = createSignal<AppError>()
  return {
    failure,
    continueWith: async (method?: BrowserAuthMethod) => {
      setFailure()
      const options: BrowserAuthSignInOptions =
        method === "email-password"
          ? { method, email: input.email(), password: input.password(), redirectUrl: input.redirect() }
          : method
            ? { method, redirectUrl: input.redirect() }
            : { redirectUrl: input.redirect() }
      try {
        if (input.invitation) await input.invitation.authenticate(options, input.action())
        else await input.auth.signIn(options)
      } catch (cause) {
        if (input.invitation) console.error("Organization invitation authentication failed", toAppError(cause).class)
        else setFailure(toAppError(cause))
      }
    },
  }
}

function createLoginController(token?: string) {
  const auth = useAuth()
  const server = useServer()
  const invitation = token ? createOrgInvitationFlow(auth, server.acceptOrgInvitation, token) : undefined
  const [email, setEmail] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [action, setAction] = createSignal<"signIn" | "signUp">(invitation ? "signUp" : "signIn")
  const redirect = loginRedirect()
  const login = loginAction({ auth, invitation, action, email, password, redirect: redirect.target })
  createEffect(
    on(auth.state, (state) => {
      if (state.kind !== "signedIn") return
      if (invitation) void acceptInvitation(invitation)
      else redirect.finish()
    }),
  )
  return {
    auth,
    invitation,
    email,
    setEmail,
    password,
    setPassword,
    action,
    setAction,
    continueWith: (method?: BrowserAuthMethod) => login.continueWith(method),
    joined: () => invitation?.state().kind === "joined",
    accept: () => {
      if (invitation) void acceptInvitation(invitation)
    },
    busy: () =>
      auth.state().kind === "signingIn" || ["authenticating", "accepting"].includes(invitation?.state().kind ?? "idle"),
    failure: () => {
      const state = invitation?.state()
      return state?.kind === "failed" ? state.failure : login.failure()
    },
    socialMethods: () =>
      auth.methods().filter((method): method is "google" | "github" => method === "google" || method === "github"),
  }
}

const LEAD = "Every coding agent, on any machine, from anywhere."

function LoginForm(props: { invitationToken?: string }) {
  const controller = createLoginController(props.invitationToken)
  return (
    <AuthSplit
      title={controller.invitation ? "Join your organization" : "Sign in to Claxedo"}
      lead={controller.invitation ? "Use the email address that received this invitation." : LEAD}
    >
      <Show when={controller.joined()} fallback={<LoginActions controller={controller} />}>
        <p class="auth-subtitle">You have joined the organization.</p>
        <a class="auth-button auth-button-icon" href="/">
          Continue to Claxedo
        </a>
      </Show>
      <Show when={controller.failure()}>
        {(failure) => (
          <p role="alert" class="auth-error">
            {failure().message}
          </p>
        )}
      </Show>
      <Show when={controller.auth.unavailable()}>{(reason) => <p class="auth-note">{reason()}</p>}</Show>
    </AuthSplit>
  )
}

function LoginActions(props: { controller: LoginController }) {
  const controller = props.controller
  return (
    <Show
      when={!controller.invitation || controller.auth.state().kind !== "signedIn"}
      fallback={
        <div class="auth-actions">
          <button type="button" class="auth-button" disabled={controller.busy()} onClick={controller.accept}>
            Accept invitation
          </button>
          <button
            type="button"
            class="auth-button auth-button-secondary"
            disabled={controller.busy()}
            onClick={() => void controller.auth.signOut()}
          >
            Use another account
          </button>
        </div>
      }
    >
      <div class="auth-actions">
        <Show when={controller.auth.methods().length === 0}>
          <button
            type="button"
            class="auth-button"
            disabled={controller.busy()}
            onClick={() => void controller.continueWith(undefined)}
          >
            {controller.busy() ? "Redirecting…" : "Continue"}
          </button>
        </Show>
        <For each={controller.socialMethods()}>
          {(method) => (
            <button
              type="button"
              class="auth-button auth-button-icon"
              disabled={controller.busy()}
              onClick={() => void controller.continueWith(method)}
            >
              <Show when={method === "github"}>
                <Icon name="github" size="small" />
              </Show>
              Continue with {providerName(method)}
            </button>
          )}
        </For>
        <Show when={controller.auth.methods().includes("email-password")}>
          <Show when={controller.socialMethods().length > 0}>
            <p class="auth-divider">or</p>
          </Show>
          <LoginCredentials controller={controller} secondary={controller.socialMethods().length > 0} />
        </Show>
      </div>
    </Show>
  )
}

function LoginCredentials(props: { controller: LoginController; secondary: boolean }) {
  const controller = props.controller
  return (
    <form
      class="auth-form"
      onSubmit={(event) => {
        event.preventDefault()
        void controller.continueWith("email-password")
      }}
    >
      <label class="auth-field">
        Email
        <input
          type="email"
          required
          autocomplete="email"
          value={controller.email()}
          onInput={(event) => controller.setEmail(event.currentTarget.value)}
        />
      </label>
      <label class="auth-field">
        Password
        <input
          type="password"
          required
          autocomplete={controller.action() === "signUp" ? "new-password" : "current-password"}
          value={controller.password()}
          onInput={(event) => controller.setPassword(event.currentTarget.value)}
        />
      </label>
      <button type="submit" class="auth-button" classList={{ "auth-button-secondary": props.secondary }} disabled={controller.busy()}>
        {controller.invitation
          ? controller.action() === "signUp"
            ? "Create account and join"
            : "Sign in and join"
          : "Sign in with email"}
      </button>
      <Show when={controller.invitation}>
        <button
          type="button"
          class="auth-button auth-button-secondary"
          disabled={controller.busy()}
          onClick={() => controller.setAction(controller.action() === "signUp" ? "signIn" : "signUp")}
        >
          {controller.action() === "signUp" ? "Already have an account? Sign in" : "Create an account"}
        </button>
        <p class="auth-note">After creating an account, verify your email before accepting the invitation.</p>
      </Show>
    </form>
  )
}
