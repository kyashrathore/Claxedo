import type { SurfaceActionDefinition, SurfaceComponent, SurfaceComponentName } from "./catalog"

export const SURFACE_EVENT_FIELDS = {
  TextField: { submit: ["value"] },
  ChoicePicker: { change: ["value"] },
  CheckBox: { change: ["value"] },
  Switch: { change: ["value"] },
  Tabs: { change: ["index"] },
  Board: { move: ["itemId", "fromColumn", "fromIndex", "toColumn", "toIndex"] },
} as const satisfies Partial<Record<SurfaceComponentName, Readonly<Record<string, readonly string[]>>>>

export const SURFACE_PLUGIN_ONLY_EVENTS = {
  Board: ["move"],
} as const satisfies Partial<Record<keyof typeof SURFACE_EVENT_FIELDS, readonly string[]>>

export type SurfaceProducer = "agent" | "plugin"

export type SurfaceComponentEvent = {
  readonly prop: string
  readonly action: SurfaceActionDefinition
  readonly supplied: readonly string[]
}

function isAction(value: unknown): value is SurfaceActionDefinition {
  return typeof value === "object" && value !== null && "event" in value
}

function hasEvents(name: SurfaceComponentName): name is keyof typeof SURFACE_EVENT_FIELDS {
  return Object.hasOwn(SURFACE_EVENT_FIELDS, name)
}

function eventFieldsOf(name: SurfaceComponentName): Readonly<Record<string, readonly string[]>> {
  return hasEvents(name) ? SURFACE_EVENT_FIELDS[name] : {}
}

export function surfaceComponentEvents(component: SurfaceComponent): readonly SurfaceComponentEvent[] {
  return Object.entries(eventFieldsOf(component.component)).flatMap(([prop, supplied]) => {
    const action: unknown = Reflect.get(component, prop)
    return isAction(action) ? [{ prop, action, supplied }] : []
  })
}

export function isPluginOnlyEvent(component: SurfaceComponentName, prop: string): boolean {
  const props: readonly string[] = Object.hasOwn(SURFACE_PLUGIN_ONLY_EVENTS, component) ? Reflect.get(SURFACE_PLUGIN_ONLY_EVENTS, component) : []
  return props.includes(prop)
}
