import fs from "node:fs/promises"
import path from "node:path"
import sharp from "sharp"

const dir = process.argv[2]!
const CROP = { left: 470, top: 40, width: 760, height: 740 }
const recording = JSON.parse(await fs.readFile(path.join(dir, "recording.json"), "utf8")) as {
  screencast: { n: number; wall: number; file: string }[]
  rounds: { timeOrigin: number; inputs: { at: number; target: string }[] }[]
}
const inputs = recording.rounds.flatMap((round) => round.inputs.map((input) => round.timeOrigin + input.at))
const ink = async (file: string) => {
  const image = sharp(path.join(dir, "frames", file))
  const { width = 1440 } = await image.metadata()
  const scale = width / 1440
  const raw = await image
    .extract({ left: Math.round(CROP.left * scale), top: Math.round(CROP.top * scale), width: Math.round(CROP.width * scale), height: Math.round(CROP.height * scale) })
    .greyscale()
    .raw()
    .toBuffer()
  let dark = 0
  for (let index = 0; index < raw.length; index += 3) if (raw[index]! < 160) dark += 1
  return (dark * 3) / raw.length
}
const values: { file: string; wall: number; ink: number }[] = []
for (const shot of recording.screencast) values.push({ file: shot.file, wall: shot.wall, ink: await ink(shot.file) })
const flagged = values.filter((value, index) => {
  const around = values.slice(Math.max(0, index - 6), index + 7).map((entry) => entry.ink).sort((a, b) => a - b)
  const median = around[Math.floor(around.length / 2)]!
  return value.ink < 0.004 || value.ink < median * 0.4
})
const since = (wall: number) => {
  const before = inputs.filter((at) => at <= wall).at(-1)
  return before === undefined ? "before-first-input" : `+${Math.round(wall - before)}ms after input ${inputs.indexOf(before)}`
}
const sorted = values.map((value) => value.ink).sort((a, b) => a - b)
console.log(`frames ${values.length}; ink p0 ${sorted[0]?.toFixed(4)} p1 ${sorted[Math.floor(sorted.length / 100)]?.toFixed(4)} p50 ${sorted[Math.floor(sorted.length / 2)]?.toFixed(4)}`)
for (const value of flagged) console.log(`${value.file} ink=${value.ink.toFixed(4)} ${since(value.wall)}`)
