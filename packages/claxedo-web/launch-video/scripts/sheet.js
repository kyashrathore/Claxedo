import { mkdir, rm } from "node:fs/promises"
import { arg, FFMPEG, launch, OUT } from "./film.js"

/**
 * Contact sheets for review.
 *   --cut film --every 2              one frame per 2 s → out/sheet-film.png
 *   --cut film --from 6 --to 7.4 --step 0.1 --label flight   a strip around a transition
 *   --cut film --at 9,15.5            full-size frames only, in out/sheet-film/
 */
const cut = arg("cut", "film")
const label = arg("label")
const exact = arg("at")?.split(",").map(Number)
const name = label ? `sheet-${cut}-${label}` : `sheet-${cut}`
const dir = `${OUT}${name}/`
await rm(dir, { recursive: true, force: true })
await mkdir(dir, { recursive: true })

const studio = await launch()
const { meta, frame } = await studio.open(cut)
const last = meta.duration - 1 / meta.fps
const every = Number(arg("every", "2"))
const from = Number(arg("from", "0"))
const step = Number(arg("step", "0"))
const times = exact
  ?? (step
    ? Array.from({ length: Math.round((Number(arg("to")) - from) / step) + 1 }, (_, i) => Math.min(from + i * step, last))
    : Array.from({ length: Math.floor(meta.duration / every) + 1 }, (_, i) => Math.min(i * every + every / 2, last)))
for (const [i, t] of times.entries()) await Bun.write(`${dir}${String(i).padStart(3, "0")}.png`, await frame(t))
await studio.close()

if (!exact) {
  const landscape = meta.width > meta.height
  const columns = step ? Math.min(times.length, landscape ? 5 : 8) : landscape ? 4 : 6
  const rows = Math.ceil(times.length / columns)
  const width = landscape ? 640 : 360
  const run = Bun.spawnSync([FFMPEG, "-loglevel", "error", "-y", "-i", `${dir}%03d.png`, "-vf", `scale=${width}:-1:flags=lanczos,pad=iw+8:ih+8:4:4:white,tile=${columns}x${rows}:color=white`, "-frames:v", "1", `${OUT}${name}.png`])
  if (run.exitCode !== 0) throw new Error(run.stderr.toString())
  console.log(`${name} → ${OUT}${name}.png: ${times.map((t) => t.toFixed(2)).join(", ")}`)
} else {
  console.log(`frames → ${dir} at ${times.join(", ")}`)
}
