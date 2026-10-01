import type { Project, ProjectId } from "@/server"

export const AVATAR_COLOR_KEYS = ["pink", "mint", "orange", "purple", "cyan", "lime"] as const

export type ProjectColorPlan = {
  readonly assignments: Array<{ id: ProjectId; color: string }>
  readonly remoteUpdates: Array<{ id: ProjectId; color: string }>
}

type ColorPlanInput = {
  readonly configurationAvailable: boolean
  readonly projects: readonly Pick<Project, "id" | "icon">[]
  readonly colors: Readonly<Record<string, string>>
  readonly requested: Map<string, string>
  readonly pick: (used: Set<string>) => string
}

export function pickAvailableColor(used: Set<string>): string {
  const available = AVATAR_COLOR_KEYS.filter((color) => !used.has(color))
  const pool = available.length === 0 ? AVATAR_COLOR_KEYS : available
  return pool[Math.floor(Math.random() * pool.length)] ?? "pink"
}

export function planProjectColorAssignment(input: ColorPlanInput): ProjectColorPlan {
  const plan: ProjectColorPlan = { assignments: [], remoteUpdates: [] }
  const used = new Set<string>()
  for (const project of input.projects) {
    if (project.icon?.color) input.requested.delete(project.id)
    const color = project.icon?.color ?? input.colors[project.id]
    if (color) used.add(color)
  }
  for (const project of input.projects) {
    if (project.icon?.color) continue
    const existing = input.colors[project.id]
    const color = existing ?? input.pick(used)
    if (!existing) {
      used.add(color)
      plan.assignments.push({ id: project.id, color })
    }
    if (!input.configurationAvailable || input.requested.get(project.id) === color) continue
    input.requested.set(project.id, color)
    plan.remoteUpdates.push({ id: project.id, color })
  }
  return plan
}
