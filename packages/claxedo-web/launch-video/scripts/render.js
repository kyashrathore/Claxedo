import { mkdir, rm } from "node:fs/promises"
import { arg, FFMPEG, launch, OUT } from "./film.js"
import { renderWav } from "./score.js"

/**
 * Renders a cut to out/<cut>.mp4: frames are captured from two pages in parallel
 * (the 24 GB machine's budget), each half encoded straight from a PNG pipe, then the
 * halves are joined without re-encoding and muxed with the score.
 */
const cut = arg("cut", "film")
const pages = Number(arg("pages", "2"))
const silent = cut === "loop"
const x264 = ["-c:v", "libx264", "-preset", "slow", "-profile:v", "high", "-pix_fmt", "yuv420p", "-crf", "16", "-g", "120", "-bf", "2"]
const run = (args) => {
  const result = Bun.spawnSync([FFMPEG, "-loglevel", "error", "-y", ...args])
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

await mkdir(OUT, { recursive: true })
const studio = await launch()
const workers = await Promise.all(Array.from({ length: pages }, () => studio.open(cut)))
const { duration, fps } = workers[0].meta
const total = Math.round(duration * fps)
const started = performance.now()
let done = 0

const segment = async ({ frame }, index) => {
  const from = Math.floor((total * index) / pages)
  const to = Math.floor((total * (index + 1)) / pages)
  const path = `${OUT}${cut}.part${index}.mp4`
  const encoder = Bun.spawn([FFMPEG, "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-", ...x264, "-r", String(fps), path], { stdin: "pipe", stderr: "inherit" })
  for (let n = from; n < to; n++) {
    encoder.stdin.write(await frame(n / fps))
    await encoder.stdin.flush()
    if (++done % 300 === 0) console.log(`${cut}: ${done}/${total} frames, ${((performance.now() - started) / 1000).toFixed(0)} s`)
  }
  encoder.stdin.end()
  if ((await encoder.exited) !== 0) throw new Error(`encoder ${index} failed`)
  return path
}

const parts = await Promise.all(workers.map(segment))
const wav = silent ? null : await renderWav(studio, cut, `${OUT}${cut}.wav`)
await studio.close()

const list = `${OUT}${cut}.parts.txt`
await Bun.write(list, parts.map((part) => `file '${part}'`).join("\n"))
const output = `${OUT}claxedo-${cut}.mp4`
run(["-f", "concat", "-safe", "0", "-i", list, ...(wav ? ["-i", wav, "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-shortest"] : []), "-c:v", "copy", "-movflags", "+faststart", output])
run(["-sseof", `-${1 / fps}`, "-i", output, "-frames:v", "1", "-update", "1", `${OUT}claxedo-${cut}-poster.png`])
for (const part of parts) await rm(part)
await rm(list)
console.log(`${output} (${total} frames, ${duration} s) in ${((performance.now() - started) / 1000).toFixed(0)} s`)
