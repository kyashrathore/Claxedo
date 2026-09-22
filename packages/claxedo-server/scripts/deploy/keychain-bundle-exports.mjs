#!/usr/bin/env node
/**
 * Turn a JSON secret bundle on stdin into `export NAME='value'` lines for the
 * calling shell to `eval`. Names come from NAMES; a name the bundle does not
 * carry is an error, never an empty export that would surface later as a
 * confusing failure inside the release.
 *
 * Nothing is written to stderr except the name that is missing, so a value
 * cannot reach a log through this process.
 */

const names = (process.env.NAMES ?? "").split(/\s+/).filter(Boolean)
if (names.length === 0) {
  process.stderr.write("NAMES must list at least one secret to export\n")
  process.exit(1)
}

let raw = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => (raw += chunk))
process.stdin.on("end", () => {
  let bundle
  try {
    bundle = JSON.parse(raw.trim())
  } catch {
    process.stderr.write("the keychain item does not hold a JSON object of secrets\n")
    process.exit(1)
  }
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    process.stderr.write("the keychain item does not hold a JSON object of secrets\n")
    process.exit(1)
  }
  const lines = []
  for (const name of names) {
    const value = bundle[name]
    if (typeof value !== "string" || value === "") {
      process.stderr.write(`the keychain item does not carry ${name}\n`)
      process.exit(1)
    }
    lines.push(`export ${name}='${value.replaceAll("'", `'"'"'`)}'`)
  }
  process.stdout.write(`${lines.join("\n")}\n`)
})
