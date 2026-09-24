/**
 * What a harness receives in place of a credential.
 *
 * A bound row carries one binding's broker path, a signed capability for that
 * binding alone, and the mode naming the header the harness must carry it in.
 * The credential's own bytes stay with the authority that minted the binding
 * and never reach this process.
 *
 * An unavailable row says the operator selected an account for this provider
 * that cannot be bound. Without it a withdrawn account reaches a harness as an
 * absent projection, and the turn runs on whatever login the machine holds —
 * under an identity the operator did not choose.
 */
export type ProviderBinding = {
  baseUrl: string
  placeholder: string
  authMode: "api-key" | "bearer"
  /**
   * Absent when the placeholder has no lifetime of its own: a sandbox provider
   * that substitutes on egress holds the value until the authority withdraws
   * it, so there is no moment at which the harness must stop using it.
   */
  expiresAt?: number
  /**
   * Where the vendor's API root sits under `baseUrl`. A client that appends the
   * whole vendor path itself (Claude Code, the Cursor SDK) is configured with
   * `baseUrl`; one configured with an API root (Codex, Pi, the OpenCode engine)
   * appends this. Absent from an authority that does not model vendor paths,
   * which means `baseUrl` is already the root.
   */
  apiPath?: string
}

export type ProviderUnavailable = {
  unavailable: true
  reason: string
}

export type ProviderProjection = ProviderBinding | ProviderUnavailable

/**
 * What an authority puts on the wire, before the runtime resolves it.
 *
 * An authority that mints the placeholder itself sends it. One whose sandbox
 * provider issues the placeholder — Daytona substitutes the value of an env var
 * it filled, and only the sandbox can read it — names that env var instead, and
 * `providerProjection` reads it off the runtime's own environment. Exactly one
 * of the two is a projection; both or neither is not.
 */
export type ProviderBindingSource =
  & Omit<ProviderBinding, "placeholder">
  & ({ placeholder: string; placeholderEnv?: undefined } | { placeholderEnv: string; placeholder?: undefined })

export type ProviderProjectionSource = ProviderBindingSource | ProviderUnavailable

/** The environment a `placeholderEnv` row is resolved against. */
export type PlaceholderEnvironment = Record<string, string | undefined>
