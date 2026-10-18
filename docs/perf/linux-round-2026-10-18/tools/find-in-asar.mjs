import { extractFile, listPackage } from "@electron/asar"

const [asarPath, needle, prefix = "/out/renderer/"] = process.argv.slice(2)
if (!asarPath || !needle) throw new Error("usage: find-in-asar.mjs <app.asar> <string> [path prefix]")
const matches = listPackage(asarPath, { isPack: false })
  .filter((file) => file.startsWith(prefix) && /\.(js|html|css|json)$/u.test(file))
  .filter((file) => extractFile(asarPath, file.slice(1)).includes(needle))
if (matches.length === 0) {
  console.error(`"${needle}" is not in ${asarPath} under ${prefix}`)
  process.exit(1)
}
console.log(`"${needle}" found in ${matches.join(", ")}`)
