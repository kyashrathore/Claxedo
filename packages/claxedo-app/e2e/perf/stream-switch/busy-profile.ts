import fs from "node:fs"
import { createSourceMapper, profileFrameLabel, profileFrameSource, profileTree, type CpuProfile } from "../panel/trace"

const IDLE = new Set(["(idle)", "(program)"])

type Sample = { id: number; at: number; dt: number }

export function readBusyProfile(file: string, distDir: string, minMs: number) {
  const profile = JSON.parse(fs.readFileSync(file, "utf8")) as CpuProfile & { startTime: number }
  const mapper = createSourceMapper(distDir)
  const { byId, parent } = profileTree(profile)
  const frame = (id: number) => byId.get(id)!.callFrame
  let time = profile.startTime
  const segments: Sample[][] = []
  let current: Sample[] = []
  profile.samples.forEach((id, index) => {
    time += profile.timeDeltas[index] ?? 0
    if (IDLE.has(frame(id).functionName)) {
      if (current.length) segments.push(current)
      current = []
    } else current.push({ id, at: time, dt: profile.timeDeltas[index + 1] ?? 0 })
  })
  if (current.length) segments.push(current)
  return {
    parent,
    busy: segments.filter((segment) => (segment.at(-1)!.at - segment[0]!.at) / 1000 >= minMs),
    label: (id: number) => profileFrameLabel(mapper, frame(id)),
    sourceFile: (id: number) => profileFrameSource(mapper, frame(id)).split(":")[0] ?? "",
  }
}
