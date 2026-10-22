import { readFileSync } from "node:fs"

/** The relay's deployed `compatibility_date`, so a real-workerd test boots the relay as it ships. */
export function relayCompatibilityDate(config = "wrangler.toml") {
  const source = readFileSync(new URL(`../../${config}`, import.meta.url), "utf8")
  const declared = /^compatibility_date = "([\d-]+)"$/m.exec(source)?.[1]
  if (!declared) throw new Error(`${config} declares no compatibility_date`)
  return declared
}
