import { useQuery } from "@tanstack/solid-query"
import { useServer } from "@/app/connection/server"
import { deploymentPostureFailure, deploymentPostureQuery } from "@/platform/query/control-plane"
import type { AuthSessionStatus } from "@/platform/auth/auth-session"

/**
 * What the active server has said about `deployment.issuesSessions`.
 *
 * Three states, not a boolean and a flag: "has not answered yet" and "could
 * not be read" lead to different screens, and collapsing either into a posture
 * means guessing whether this deployment's visitor must sign in. `unreadable`
 * is every way a read can end without an answer — refused, undeclared, or
 * unreachable.
 */
export type DeploymentPosture =
  | { readonly status: "pending" }
  | { readonly status: "declared"; readonly issuesSessions: boolean }
  | { readonly status: "unreadable"; readonly reason: string }

/**
 * The active server's own answer to "do I issue the sessions a caller must
 * hold?", read from `deployment.issuesSessions` in its bootstrap body.
 *
 * One query per server URL, shared by every surface that has to know which
 * deployment this is — the sign-in gate, the identity provider, the telemetry
 * plane, the first-project canvas — so none of them can disagree with another.
 * Neither the URL nor the bundle can answer it: a signed node runs its issuer
 * on localhost too, and a build describes itself rather than the server it
 * reached.
 */
export function useDeploymentPosture() {
  const server = useServer()
  const query = useQuery(() => deploymentPostureQuery({ baseUrl: server.url }))
  const posture = (): DeploymentPosture => {
    // A landed declaration outranks a later failure: the answer cannot change
    // under a running server, so a failed refetch is a lost round trip rather
    // than a lost posture.
    if (query.data !== undefined) return { status: "declared", issuesSessions: query.data }
    if (query.isError) return { status: "unreadable", reason: deploymentPostureFailure(query.error) }
    return { status: "pending" }
  }
  return {
    posture,
    issuesSessions: () => query.data,
    reread: () => {
      void query.refetch()
    },
  }
}

/**
 * What the sign-in gate puts on screen, given the server's declaration and the
 * session it has.
 *
 * Separated from the gate component because these are the states the product
 * rule is made of, and the component around them is JSX. Two of them hold:
 * only a server that DECLARED renders the shell, so an unreadable declaration
 * can never produce the ungated one.
 */
export type SignInGate =
  | { readonly surface: "shell" }
  | { readonly surface: "hold"; readonly redirectToLogin: boolean }
  | { readonly surface: "unreadable"; readonly reason: string }

export function signInGate(input: { posture: DeploymentPosture; session: AuthSessionStatus }): SignInGate {
  if (input.posture.status === "unreadable") return { surface: "unreadable", reason: input.posture.reason }
  if (input.posture.status === "pending") return { surface: "hold", redirectToLogin: false }
  if (!input.posture.issuesSessions) return { surface: "shell" }
  if (input.session === "signed") return { surface: "shell" }
  // A session still loading is not an absent one: redirecting on it would send
  // a signed user through /login on every reload.
  return { surface: "hold", redirectToLogin: input.session === "anonymous" }
}
