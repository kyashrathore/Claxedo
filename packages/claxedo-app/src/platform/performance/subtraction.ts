/**
 * Compile-time diagnostic subtraction contract.
 *
 * A build has exactly one variant. `control` changes no owner; every other
 * variant names the single runtime owner that a diagnostic entry may replace.
 * Keeping this scalar (rather than independent feature flags) makes accidental
 * multi-owner experiments unrepresentable.
 */
export const SUBTRACTION_OWNERS = ["renderer", "host", "terminal", "app"] as const

export type SubtractionOwner = (typeof SUBTRACTION_OWNERS)[number]
export type SubtractionVariant = "control" | `without-${SubtractionOwner}`

export type SubtractionManifest = Readonly<{
  schema: 1
  diagnosticOnly: boolean
  variant: SubtractionVariant
  owner: SubtractionOwner | null
}>

export const CONTROL_SUBTRACTION_MANIFEST: SubtractionManifest = Object.freeze({
  schema: 1,
  diagnosticOnly: false,
  variant: "control",
  owner: null,
})

export function subtractionVariant(owner: SubtractionOwner): SubtractionVariant {
  return `without-${owner}`
}

export function parseSubtractionOwner(input: unknown): SubtractionOwner | null {
  if (typeof input !== "string") return null
  const value = input.trim()
  return (SUBTRACTION_OWNERS as readonly string[]).includes(value) ? value as SubtractionOwner : null
}

/**
 * Resolves the build-time variant and rejects diagnostic leakage into ordinary
 * development or release modes. Diagnostic builds use an explicit Vite mode,
 * so a release command cannot inherit an ablation from a shell environment.
 */
export function resolveSubtractionManifest(input: {
  mode: string
  owner?: unknown
}): SubtractionManifest {
  const raw = typeof input.owner === "string" ? input.owner.trim() : ""
  if (!raw) return CONTROL_SUBTRACTION_MANIFEST

  const owner = parseSubtractionOwner(raw)
  if (!owner) {
    throw new Error(`Unknown Claxedo subtraction owner: ${raw}`)
  }
  if (input.mode !== "performance-diagnostic") {
    throw new Error(
      `Claxedo subtraction ${subtractionVariant(owner)} requires --mode performance-diagnostic`,
    )
  }
  return Object.freeze({
    schema: 1,
    diagnosticOnly: true,
    variant: subtractionVariant(owner),
    owner,
  })
}

/** The compile-time value injected by the desktop diagnostic build. */
declare const __CLAXEDO_SUBTRACTION_OWNER__: string | null

export function compiledSubtractionOwner(): SubtractionOwner | null {
  // `typeof` keeps browser/cloud/test builds that do not define the token on
  // the unchanged control path. Vite replaces both occurrences for desktop.
  if (typeof __CLAXEDO_SUBTRACTION_OWNER__ !== "string") return null
  return parseSubtractionOwner(__CLAXEDO_SUBTRACTION_OWNER__)
}

export function ownerIsSubtracted(owner: SubtractionOwner) {
  return compiledSubtractionOwner() === owner
}
