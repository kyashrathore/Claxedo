import { traceText, type TraceEvent } from "../../harness/trace-events"
import { profileFrameLabel, profileTree, type createSourceMapper, type CpuProfile } from "../panel/trace"

export type Mapper = ReturnType<typeof createSourceMapper>

type StackFrame = { functionName?: string; url?: string; lineNumber?: number; columnNumber?: number }

const COMPILE = new Set(["v8.compile", "v8.compileModule", "v8.evaluateModule", "EvaluateScript", "CompileScript", "v8.parseOnBackground", "v8.compileEval", "CacheScript"])

export function tidyWhere(where: string) {
  return where.replace(/\S*node_modules\/\.bun\/[^/\s]+\/node_modules\//g, "").replace(/\S*?\/packages\//g, "packages/")
}

export function isScriptCompile(event: TraceEvent) {
  return COMPILE.has(event.name)
}

function fileOf(url: string | undefined) {
  return (url ?? "").split("?")[0]?.split("/").pop() || "(inline)"
}

export function compileFile(event: TraceEvent) {
  const args = event.args as { fileName?: string; data?: Record<string, unknown> } | undefined
  return fileOf(args?.fileName ?? traceText(args?.data?.url) ?? traceText(args?.data?.fileName))
}

function stackOf(event: TraceEvent): StackFrame[] {
  const args = event.args as { beginData?: { stackTrace?: StackFrame[] }; data?: { stackTrace?: StackFrame[] } } | undefined
  return args?.beginData?.stackTrace ?? args?.data?.stackTrace ?? []
}

function frameLabel(frame: StackFrame, mapper: Mapper) {
  const file = fileOf(frame.url)
  return `${frame.functionName || "(anon)"} ${mapper.map(file, frame.lineNumber ?? 0, frame.columnNumber ?? 0)}`
}

export function jsFrameAt(event: TraceEvent, script: TraceEvent, samples: { at: number[]; node: number[] }, profile: CpuProfile, mapper: Mapper) {
  const stack = stackOf(event).filter((frame) => frame.url)
  if (stack.length) return stack.slice(0, 2).map((frame) => frameLabel(frame, mapper)).join(" ← ")
  const { byId, parent } = profileTree(profile)
  let index = samples.at.findIndex((at) => at >= event.ts)
  if (index < 0) index = samples.at.length - 1
  const chain: string[] = []
  for (let id: number | undefined = samples.node[index]; id !== undefined && chain.length < 2; id = parent.get(id)) {
    const frame = byId.get(id)?.callFrame
    if (frame?.url && !frame.url.includes("vendor")) chain.push(profileFrameLabel(mapper, frame))
  }
  if (chain.length) return `${chain.join(" ← ")} (sampled)`
  const data = script.args?.data ?? {}
  return `${traceText(data.functionName) || script.name} ${fileOf(traceText(data.url))}`
}
