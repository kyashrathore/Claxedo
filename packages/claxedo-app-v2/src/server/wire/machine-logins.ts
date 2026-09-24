export type MachineLogin = { readonly harness: string; readonly signedIn: boolean; readonly providerIds: readonly string[] }

export const MACHINE_LOGINS_PATH = "/api/claxedo/credentials/machine-logins"

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

export function machineLoginsFromWire(body: unknown): readonly MachineLogin[] {
  const rows = body && typeof body === "object" ? (body as { machine_logins?: unknown }).machine_logins : undefined
  return (Array.isArray(rows) ? rows : []).flatMap((row) => {
    if (!row || typeof row !== "object") return []
    const { harness, state, providerIds } = row as { harness?: unknown; state?: unknown; providerIds?: unknown }
    return typeof harness === "string" ? [{ harness, signedIn: state === "signed_in", providerIds: strings(providerIds) }] : []
  })
}
