import fs from "node:fs"

type Result = {
  variant?: string
  workspace: string
  interaction: string
  run: number
  inputToReadyMs: number
  readyFrame?: number
  clickToReadyMs?: number
  inputToClickMs?: number
  readyFrameFromClick?: number
  inputToSettledMs: number
  inputToShellSettledMs?: number
  worstFrameMs: number
  framesOver16_7: number
  worstFrameToQuietMs?: number
  framesOver16_7ToQuiet?: number
  frameCount: number
  loafs: { duration: number; blocking: number; scripts: { fn: string; duration: number; forced: number; url: string; char: number }[] }[]
  requests: { url: string; ms: number; startMs: number }[]
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : -1
}

const files = process.argv.slice(2)
const loaded = files.map((file) => JSON.parse(fs.readFileSync(file, "utf8")) as Result[])
const variantNames = [...new Set(loaded.flat().map((result) => result.variant ?? "app"))]
const labels = variantNames.length > 1 ? variantNames : files.map((file) => file.split("/").at(-2) ?? file)
const sets = variantNames.length > 1 ? variantNames.map((name) => loaded.flat().filter((result) => (result.variant ?? "app") === name)) : loaded
const keys = [...new Set(sets.flat().map((result) => `${result.workspace}\t${result.interaction}`))]
console.log(["workspace", "interaction", ...labels.flatMap((label) => [`${label} ready med/max`, "frame# med/max", "click->ready med", "click frame# med/max", "settled med", "worst med/max", "over16.7 med", "quiet worst med/max", "quiet over", "n"])].join(" | "))
for (const key of keys) {
  const [workspace, interaction] = key.split("\t")
  const cells = sets.map((set) => {
    const rows = set.filter((result) => result.workspace === workspace && result.interaction === interaction)
    if (!rows.length) return ["-", "-", "-", "-", "-", "-", "-", "-", "-", "0"]
    return [
      `${median(rows.map((row) => row.inputToReadyMs)).toFixed(1)}/${Math.max(...rows.map((row) => row.inputToReadyMs)).toFixed(1)}`,
      `${median(rows.map((row) => row.readyFrame ?? -1))}/${Math.max(...rows.map((row) => row.readyFrame ?? -1))}`,
      median(rows.map((row) => row.clickToReadyMs ?? -1)).toFixed(1),
      `${median(rows.map((row) => row.readyFrameFromClick ?? -1))}/${Math.max(...rows.map((row) => row.readyFrameFromClick ?? -1))}`,
      median(rows.map((row) => row.inputToSettledMs)).toFixed(1),
      `${median(rows.map((row) => row.worstFrameMs)).toFixed(1)}/${Math.max(...rows.map((row) => row.worstFrameMs)).toFixed(1)}`,
      String(median(rows.map((row) => row.framesOver16_7))),
      `${median(rows.map((row) => row.worstFrameToQuietMs ?? -1)).toFixed(1)}/${Math.max(...rows.map((row) => row.worstFrameToQuietMs ?? -1)).toFixed(1)}`,
      String(median(rows.map((row) => row.framesOver16_7ToQuiet ?? -1))),
      String(rows.length),
    ]
  })
  console.log([workspace, interaction, ...cells.flat()].join(" | "))
}
if (process.env.LOAF === "1") {
  for (const [index, set] of sets.entries()) {
    console.log(`\n== LoAF scripts ${labels[index]} ==`)
    const byInteraction = new Map<string, Map<string, { ms: number; n: number }>>()
    for (const result of set) {
      const key = `${result.workspace} ${result.interaction}`
      const bucket = byInteraction.get(key) ?? new Map()
      byInteraction.set(key, bucket)
      for (const loaf of result.loafs) for (const script of loaf.scripts) {
        const name = `${script.fn || "(anon)"} ${script.url}@${script.char}`
        const entry = bucket.get(name) ?? { ms: 0, n: 0 }
        entry.ms += script.duration
        entry.n += 1
        bucket.set(name, entry)
      }
    }
    for (const [key, bucket] of byInteraction) {
      const rows = [...bucket.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 6)
      if (rows.length) console.log(`${key}: ${rows.map(([name, entry]) => `${name} ${entry.ms.toFixed(1)}ms×${entry.n}`).join(" | ")}`)
    }
  }
}
