export class InstalledBundleError extends Error {
  constructor(readonly pluginId: string, message: string) {
    super(`${pluginId}: ${message}`)
    this.name = "InstalledBundleError"
  }
}

function hex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function verifiedBundleText(pluginId: string, bytes: Uint8Array<ArrayBuffer>, sha256: string): Promise<string> {
  const actual = hex(await crypto.subtle.digest("SHA-256", bytes))
  if (actual !== sha256) throw new InstalledBundleError(pluginId, `the bundle's SHA-256 is ${actual}, not the ${sha256} the server listed`)
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch (error) {
    throw new InstalledBundleError(pluginId, `the bundle is not UTF-8 text: ${error instanceof Error ? error.message : String(error)}`)
  }
}
