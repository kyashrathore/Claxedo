import { z } from "zod"
import { SURFACE_CATALOG_ID, surfaceComponentSchema, type SurfaceComponent } from "./catalog"
import { SURFACE_MAX_COMPONENTS, SURFACE_PROTOCOL_VERSION, type SurfaceMessage } from "./messages"

export const SURFACE_ROOT_ID = "root"

export const surfaceSpecSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    components: z.array(surfaceComponentSchema).min(1).max(SURFACE_MAX_COMPONENTS),
    data: z.record(z.string(), z.json()).optional(),
  })
  .strict()

export type SurfaceSpec = z.infer<typeof surfaceSpecSchema>

export type SurfaceIssue = { readonly path: string; readonly message: string }

export type SurfaceCheck =
  | { readonly ok: true; readonly spec: SurfaceSpec }
  | { readonly ok: false; readonly issues: readonly SurfaceIssue[] }

function pointerOf(path: readonly PropertyKey[]): string {
  return path.map((key) => `/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("")
}

export function componentReferences(component: SurfaceComponent): readonly { readonly path: string; readonly id: string }[] {
  switch (component.component) {
    case "Card":
    case "Button":
    case "Collapsible":
      return [{ path: "/child", id: component.child }]
    case "Row":
    case "Column":
    case "List":
      return Array.isArray(component.children)
        ? component.children.map((id, index) => ({ path: `/children/${index}`, id }))
        : [{ path: "/children/componentId", id: component.children.componentId }]
    case "Tabs":
      return component.tabs.map((tab, index) => ({ path: `/tabs/${index}/child`, id: tab.child }))
    default:
      return []
  }
}

function cycleFrom(start: string, byId: ReadonlyMap<string, SurfaceComponent>): boolean {
  const seen = new Set<string>()
  const pending = [start]
  while (pending.length > 0) {
    const id = pending.pop() as string
    const component = byId.get(id)
    if (!component) continue
    for (const reference of componentReferences(component)) {
      if (reference.id === start) return true
      if (!seen.has(reference.id)) {
        seen.add(reference.id)
        pending.push(reference.id)
      }
    }
  }
  return false
}

function graphIssues(components: readonly SurfaceComponent[]): SurfaceIssue[] {
  const issues: SurfaceIssue[] = []
  const byId = new Map<string, SurfaceComponent>()
  components.forEach((component, index) => {
    if (byId.has(component.id)) issues.push({ path: `/components/${index}/id`, message: `the id ${component.id} is used twice` })
    byId.set(component.id, component)
  })
  if (!byId.has(SURFACE_ROOT_ID)) issues.push({ path: "/components", message: `no component has the id ${SURFACE_ROOT_ID}` })
  components.forEach((component, index) => {
    for (const reference of componentReferences(component)) {
      if (!byId.has(reference.id)) issues.push({ path: `/components/${index}${reference.path}`, message: `no component has the id ${reference.id}` })
    }
    if (cycleFrom(component.id, byId)) issues.push({ path: `/components/${index}`, message: `${component.id} contains itself` })
  })
  return issues
}

export function checkSurfaceSpec(value: unknown): SurfaceCheck {
  const parsed = surfaceSpecSchema.safeParse(value)
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((issue) => ({ path: pointerOf(issue.path), message: issue.message })) }
  const issues = graphIssues(parsed.data.components)
  return issues.length > 0 ? { ok: false, issues } : { ok: true, spec: parsed.data }
}

export function surfaceSpecMessages(surfaceId: string, spec: SurfaceSpec): SurfaceMessage[] {
  return [
    { version: SURFACE_PROTOCOL_VERSION, createSurface: { surfaceId, catalogId: SURFACE_CATALOG_ID } },
    { version: SURFACE_PROTOCOL_VERSION, updateComponents: { surfaceId, components: spec.components } },
    ...(spec.data ? [{ version: SURFACE_PROTOCOL_VERSION, updateDataModel: { surfaceId, path: "/", value: spec.data } } as const] : []),
  ]
}
