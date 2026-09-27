import fs from "node:fs/promises"
import path from "node:path"

export const CONTENT_CROP = { left: 470, top: 40, width: 760, height: 740 }

type Pane = { id: string; shown: boolean; cv: string; vis: string; presence: string; opacity: string; rows: number; chars: number; top: number; fromEnd: number; height: number; loading: number }
export type Frame = { raf: number; at: number; rail: string; url: string; panes: Pane[] }
type Probe = { timeOrigin: number; frames: Frame[]; inputs: { at: number; target: string }[]; loafs: { start: number; duration: number }[] }
export type Recording = {
  alpha: string
  beta: string
  ids?: Record<string, string>
  screencast: { n: number; wall: number; file: string }[]
  rounds: Probe[]
}

export async function readRecording(dir: string) {
  return JSON.parse(await fs.readFile(path.join(dir, "recording.json"), "utf8")) as Recording
}
