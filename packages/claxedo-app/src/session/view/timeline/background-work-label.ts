import type { BackgroundWork } from "@/server"
import type { TimelineTranslate } from "./model"

type Kind = "agents" | "shells" | "tasks" | "shellsRunning" | "tasksRunning"

function counted(kind: Kind, count: number, t: TimelineTranslate): string {
  return t(`session.timeline.backgroundWork.${kind}.${count === 1 ? "one" : "other"}`, { count })
}

export function backgroundWorkLabel(work: BackgroundWork, t: TimelineTranslate): string | undefined {
  const [lead, ...rest] = [
    work.agents > 0 ? counted("agents", work.agents, t) : undefined,
    work.shells > 0 ? counted(work.agents > 0 ? "shells" : "shellsRunning", work.shells, t) : undefined,
    work.other > 0 ? counted(work.agents + work.shells > 0 ? "tasks" : "tasksRunning", work.other, t) : undefined,
  ].filter((segment): segment is string => segment !== undefined)
  return lead === undefined ? undefined : [lead, ...rest].join(" · ")
}
