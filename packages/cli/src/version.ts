import { readFileSync } from "node:fs"
import { asRecordOrEmpty, nonEmptyString } from "@claxedo/helpers/guards"

/** Read from the manifest beside `src/` and `dist/` alike, which npm ships in every tarball. */
export function cliVersion(): string {
  const manifest = asRecordOrEmpty(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")))
  const version = nonEmptyString(manifest.version)
  if (!version) throw new Error("@claxedo/cli package.json has no version")
  return version
}
