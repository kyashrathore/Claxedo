import fs from "node:fs/promises"
import path from "node:path"
import sharp from "sharp"

type Pane = { id: string; shown: boolean; cv: string; vis: string; presence: string; opacity: string; rows: number; chars: number; top: number; fromEnd: number; height: number; loading: number }
type Frame = { raf: number; at: number; rail: string; url: string; panes: Pane[] }
type Probe = { timeOrigin: number; frames: Frame[]; inputs: { at: number; target: string }[]; loafs: { start: number; duration: number }[] }
type Recording = {
  alpha: string
  beta: string
  screencast: { n: number; wall: number; file: string }[]
  rounds: Probe[]
}

const dir = process.argv[2]!
const WINDOW_MS = 1000
const CROP = { left: 470, top: 40, width: 760, height: 740 }
const BLANK_STDEV = 4

const recording = JSON.parse(await fs.readFile(path.join(dir, "recording.json"), "utf8")) as Recording
const titles = new Map(Object.entries((recording as unknown as { ids?: Record<string, string> }).ids ?? {}).map(([title, id]) => [id, title]))
const name = (id: string) => titles.get(id) ?? (id === recording.alpha ? "A" : id === recording.beta ? "B" : id ? "?" : "-")

const content = (frame: Frame, id?: string) => frame.panes.find((pane) => pane.shown && pane.rows > 0 && pane.chars > 40 && (!id || pane.id === id))
const describe = (frame: Frame) =>
  frame.panes.map((pane) => `${name(pane.id)}:${pane.presence}${pane.shown ? "" : "/hidden"} rows=${pane.rows} chars=${pane.chars} top=${pane.top} end=${pane.fromEnd} load=${pane.loading}`).join(" | ") || "no pane"

async function stdev(file: string) {
  const stats = await sharp(path.join(dir, "frames", file)).extract(CROP).stats()
  return Math.max(...stats.channels.map((channel) => channel.stdev))
}

const report = []
const gaps: { at: number; gap: number }[] = []
for (const [round, { frames, inputs, timeOrigin }] of recording.rounds.entries()) {
gaps.push(...frames.slice(1).map((frame, index) => ({ at: frame.raf, gap: frame.raf - frames[index]!.raf })).filter((entry) => entry.gap > 34))
for (const [index, input] of inputs.entries()) {
  const end = Math.min(input.at + WINDOW_MS, inputs[index + 1]?.at ?? Infinity)
  const window = frames.filter((frame) => frame.at >= input.at && frame.at <= end)
  const revealIndex = window.findIndex((frame) => content(frame, input.target))
  const domBlank = window.filter((frame) => !content(frame))
  const afterReveal = revealIndex < 0 ? [] : window.slice(revealIndex).filter((frame) => !content(frame, input.target))
  const wallIn = timeOrigin + input.at
  const shots = recording.screencast.filter((shot) => shot.wall >= wallIn - 20 && shot.wall <= timeOrigin + end)
  const pixels = await Promise.all(shots.map(async (shot) => ({ ...shot, ms: Math.round(shot.wall - wallIn), stdev: await stdev(shot.file) })))
  const blankShots = pixels.filter((shot) => shot.stdev < BLANK_STDEV)
  const nextRaf = window[0]?.raf
  report.push({
    round,
    switch: index,
    to: name(input.target),
    revealFrames: revealIndex,
    revealMs: revealIndex < 0 ? undefined : Math.round(window[revealIndex]!.at - input.at),
    domBlankFrames: domBlank.length,
    domBlankMs: domBlank.map((frame) => Math.round(frame.at - input.at)),
    lostAfterReveal: afterReveal.map((frame) => `+${Math.round(frame.at - input.at)} ${describe(frame)}`),
    blankShots: blankShots.map((shot) => `${shot.file}@+${shot.ms}ms sd=${shot.stdev.toFixed(1)}`),
    firstRafAfterInput: nextRaf === undefined ? undefined : Math.round(nextRaf - input.at),
    domStates: [...new Set(window.slice(0, Math.max(revealIndex + 2, 3)).map((frame) => `+${Math.round(frame.at - input.at)} ${describe(frame)}`))],
  })
}
}

const summary = {
  switches: report.length,
  withDomBlank: report.filter((row) => row.domBlankFrames > 0).length,
  withBlankShots: report.filter((row) => row.blankShots.length > 0).length,
  withLostAfterReveal: report.filter((row) => row.lostAfterReveal.length > 0).length,
  reveal: report.map((row) => `${row.to}:${row.revealFrames}f/${row.revealMs}ms`).join(" "),
  longFrameGaps: gaps.map((entry) => `${Math.round(entry.at)}:${Math.round(entry.gap)}ms`).join(" "),
}
await fs.writeFile(path.join(dir, "report.json"), JSON.stringify({ summary, report }, null, 1))
console.log(JSON.stringify(summary, null, 1))
for (const row of report) if (row.domBlankFrames || row.blankShots.length || row.lostAfterReveal.length) console.log(JSON.stringify(row, null, 1))
