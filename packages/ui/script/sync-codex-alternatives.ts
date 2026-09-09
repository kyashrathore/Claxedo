import manifest from "../src/assets/icons/codex-alternatives/manifest.json"

// Materialize reviewed native definitions without altering the historical extraction.
const symbols = manifest.icons.map((icon) => {
  const attributes = (icon.kind === "named"
    ? ` viewBox="${icon.viewBox}" fill="currentColor"`
    : icon.rootAttributes!).replace(/ (?:width|height|xmlns)="[^"]*"/g, "")
  return `  <symbol id="${icon.id}"${attributes}>${icon.body}</symbol>`
})
await Bun.write(new URL("../src/assets/icons/codex-alternatives/sprite.svg", import.meta.url),
  `<svg xmlns="http://www.w3.org/2000/svg">\n${symbols.join("\n")}\n</svg>\n`)
const target = new URL("../src/assets/icons/codex/sprite.svg", import.meta.url)
const historical = (await Bun.file(target).text()).replace(/\s*<symbol id="codex-native-[\s\S]*?<\/symbol>/g, "")
const native = symbols.map((symbol) => symbol.replace('<symbol id="', '<symbol id="codex-native-')).join("\n")
await Bun.write(target, historical.replace(/\s*<\/svg>/, `\n${native}\n</svg>`))
console.log(`Synced ${symbols.length} reviewed native icons into both sprites.`)
