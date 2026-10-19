import { z } from "zod"
import { SURFACE_CATALOG_ID, surfaceComponentSchema, type SurfaceChildList, type SurfaceComponent } from "./catalog"
import { isPluginOnlyEvent, surfaceComponentEvents, type SurfaceProducer } from "./events"
import { SURFACE_IMAGE_REFUSALS, surfaceImageUrl } from "./image-url"
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

type ComponentReference = { readonly path: string; readonly id: string }

function listReferences(path: string, ids: readonly string[] | undefined): ComponentReference[] {
  return (ids ?? []).map((id, index) => ({ path: `${path}/${index}`, id }))
}

function childListReferences(children: SurfaceChildList): ComponentReference[] {
  return Array.isArray(children) ? listReferences("/children", children) : [{ path: "/children/componentId", id: children.componentId }]
}

export function componentReferences(component: SurfaceComponent): readonly ComponentReference[] {
  switch (component.component) {
    case "Card":
    case "Button":
    case "Collapsible":
      return [{ path: "/child", id: component.child }]
    case "Row":
    case "Column":
    case "List":
    case "Grid":
      return childListReferences(component.children)
    case "Tabs":
      return component.tabs.map((tab, index) => ({ path: `/tabs/${index}/child`, id: tab.child }))
    case "Header":
      return [...listReferences("/badges", component.badges), ...listReferences("/actions", component.actions)]
    case "Section":
      return [{ path: "/child", id: component.child }, ...listReferences("/actions", component.actions)]
    case "ListItem":
      return [
        ...listReferences("/meta", component.meta),
        ...(component.primaryAction === undefined ? [] : [{ path: "/primaryAction", id: component.primaryAction }]),
        ...listReferences("/actions", component.actions),
      ]
    case "Callout":
      return component.action === undefined ? [] : [{ path: "/action", id: component.action }]
    case "Footer":
      return [...listReferences("/start", component.start), ...listReferences("/end", component.end)]
    case "Board":
      return [
        { path: "/item", id: component.item },
        ...component.columns.flatMap((column, index) => [
          ...listReferences(`/columns/${index}/headerActions`, column.headerActions),
          ...(column.footer === undefined ? [] : [{ path: `/columns/${index}/footer`, id: column.footer }]),
        ]),
      ]
    default:
      return []
  }
}

function cycleFrom(start: string, byId: ReadonlyMap<string, SurfaceComponent>): boolean {
  const seen = new Set<string>()
  const pending = [start]
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
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

function eventIssues(component: SurfaceComponent, at: string, producer: SurfaceProducer): SurfaceIssue[] {
  return surfaceComponentEvents(component).flatMap((event) => [
    ...(producer === "agent" && isPluginOnlyEvent(component.component, event.prop)
      ? [{ path: `${at}/${event.prop}`, message: `the ${component.component}'s ${event.prop} event is for app plugin pages; an agent reply leaves it out` }]
      : []),
    ...Object.keys(event.action.event.context ?? {})
      .filter((key) => event.supplied.includes(key))
      .map((key) => ({
        path: `${at}/${event.prop}/event/context/${pointerOf([key]).slice(1)}`,
        message: `the ${component.component}'s ${event.prop} event supplies ${key} itself; give this context entry another name`,
      })),
  ])
}

function imageIssues(component: SurfaceComponent, at: string): SurfaceIssue[] {
  if (component.component !== "Image" || typeof component.url !== "string") return []
  const checked = surfaceImageUrl(component.url)
  return checked.ok ? [] : [{ path: `${at}/url`, message: SURFACE_IMAGE_REFUSALS[checked.reason] }]
}

function boardIssues(component: SurfaceComponent, at: string): SurfaceIssue[] {
  if (component.component !== "Board") return []
  return component.columns.flatMap((column, index) =>
    component.columns.findIndex((other) => other.key === column.key) === index
      ? []
      : [{ path: `${at}/columns/${index}/key`, message: `the column key ${column.key} is used twice` }],
  )
}

function componentIssues(components: readonly SurfaceComponent[], producer: SurfaceProducer): SurfaceIssue[] {
  return components.flatMap((component, index) => {
    const at = `/components/${index}`
    return [...eventIssues(component, at, producer), ...imageIssues(component, at), ...boardIssues(component, at)]
  })
}

export type SurfaceCheckOptions = { readonly producer?: SurfaceProducer }

export function checkSurfaceSpec(value: unknown, options: SurfaceCheckOptions = {}): SurfaceCheck {
  const parsed = surfaceSpecSchema.safeParse(value)
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((issue) => ({ path: pointerOf(issue.path), message: issue.message })) }
  const issues = [...graphIssues(parsed.data.components), ...componentIssues(parsed.data.components, options.producer ?? "plugin")]
  return issues.length > 0 ? { ok: false, issues } : { ok: true, spec: parsed.data }
}

export function surfaceSpecMessages(surfaceId: string, spec: SurfaceSpec): SurfaceMessage[] {
  return [
    { version: SURFACE_PROTOCOL_VERSION, createSurface: { surfaceId, catalogId: SURFACE_CATALOG_ID } },
    { version: SURFACE_PROTOCOL_VERSION, updateComponents: { surfaceId, components: spec.components } },
    ...(spec.data ? [{ version: SURFACE_PROTOCOL_VERSION, updateDataModel: { surfaceId, path: "/", value: spec.data } } as const] : []),
  ]
}
