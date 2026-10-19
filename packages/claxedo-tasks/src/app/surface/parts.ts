import type { SurfaceActionDefinition, SurfaceComponent, SurfaceDataBinding, SurfaceDynamicValue } from "@claxedo/plugin-api"
import type { SURFACE_ICON_NAMES } from "@claxedo/plugin-api/surface"

export type SurfaceIcon = (typeof SURFACE_ICON_NAMES)[number]

export type Text = string | SurfaceDataBinding

export type ButtonStyle = "default" | "primary" | "borderless"

export type ActionContext = Readonly<Record<string, SurfaceDynamicValue>>

export type ButtonOptions = {
  readonly variant?: ButtonStyle
  readonly icon?: SurfaceIcon | SurfaceDataBinding
  readonly context?: ActionContext
}

export function bound(path: string): SurfaceDataBinding {
  return { path }
}

export function action(name: string, context?: ActionContext): SurfaceActionDefinition {
  return { event: context ? { name, context: { ...context } } : { name } }
}

export function surfaceText(id: string, value: Text, variant?: "h4" | "caption" | "body"): SurfaceComponent {
  return { id, component: "Text", text: value, ...(variant ? { variant } : {}) }
}

export function surfaceButton(id: string, label: Text, event: string, options: ButtonOptions = {}): SurfaceComponent[] {
  return [
    {
      id,
      component: "Button",
      child: `${id}-label`,
      ...(options.variant ? { variant: options.variant } : {}),
      ...(options.icon ? { icon: options.icon } : {}),
      action: action(event, options.context),
    },
    surfaceText(`${id}-label`, label),
  ]
}

export function surfaceColumn(id: string, children: readonly string[]): SurfaceComponent {
  return { id, component: "Column", children: [...children] }
}

export type SectionOptions = {
  readonly title?: Text
  readonly description?: Text
  readonly actions?: readonly string[]
  readonly plain?: boolean
}

export function surfaceSection(id: string, child: string, options: SectionOptions = {}): SurfaceComponent {
  return {
    id,
    component: "Section",
    child,
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(options.actions && options.actions.length > 0 ? { actions: [...options.actions] } : {}),
    ...(options.plain ? { variant: "plain" as const } : {}),
  }
}

export type CalloutTone = "info" | "success" | "warning" | "danger"

export type CalloutOptions = { readonly text?: Text; readonly action?: string; readonly dismissible?: boolean }

export function callout(id: string, tone: CalloutTone, title: Text, options: CalloutOptions = {}): SurfaceComponent {
  return {
    id,
    component: "Callout",
    tone,
    title,
    ...(options.text === undefined ? {} : { text: options.text }),
    ...(options.action ? { action: options.action } : {}),
    ...(options.dismissible ? { dismissible: true } : {}),
  }
}

export function footer(id: string, end: readonly string[], start: readonly string[] = []): SurfaceComponent {
  return { id, component: "Footer", end: [...end], ...(start.length > 0 ? { start: [...start] } : {}) }
}
