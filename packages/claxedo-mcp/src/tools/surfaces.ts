/**
 * Native UI an agent shows in its own Claxedo transcript.
 *
 * The app renders the `ui_show` call's input as the surface, so the transcript
 * is the only storage and the handler has nothing to do beyond checking the
 * graph the input schema cannot express.
 */
import { SURFACE_DESIGN_GUIDE, checkSurfaceSpec, surfaceComponentSchema, surfaceSpecSchema } from "@claxedo/plugin-api/surface"
import { mcpToolRefusal } from "../mcp-tool"
import type { ToolRegistrar } from "./registry"
import { declaredToolAccess } from "./inventory"
import { toolText } from "./target"

const COMPONENT_NAMES = surfaceComponentSchema.options.map((option) => option.shape.component.value)

export const UI_SHOW_DESCRIPTION = [
  "Show a native UI surface to the person in this Claxedo session's transcript. Use it for a reply that reads better as UI than text: a table, metrics, a choice, a short form. For more than a few components, call ui_guide first.",
  "Shape (A2UI v0.9): `components` is a flat list; each has a unique `id` and a `component` name, and the one with id \"root\" is drawn. Containers name children by id: Row, Column, List and Grid take `children: [ids]`; Card, Button, Collapsible and Section take `child`; Tabs take `tabs[].child`; Header, Section and ListItem take `actions: [ids]`, Header `badges`, ListItem `meta` and `primaryAction` (one id); a Footer takes `start: [ids]` and `end: [ids]`.",
  "Any text, number or boolean prop may instead be a binding `{\"path\": \"/a/b\"}`, a JSON Pointer into `data`. To repeat a component per array item, give a container `children: {\"componentId\": \"row\", \"path\": \"/items\"}`; inside that template a path without a leading slash is relative to the item, as `{\"path\": \"name\"}`.",
  "Inputs (TextField, CheckBox, Switch, ChoicePicker, Slider, DateTimeInput) bind `value` to a data path. A Button needs a `child` (usually a Text) and `action: {\"event\": {\"name\": \"...\", \"context\": {...}}}`, whose context values may be bindings such as an input's path. When the person presses it and confirms, the event reaches you as a new user message carrying its name and resolved context. Inputs may also declare an event of the same shape (TextField `submit`, ChoicePicker, CheckBox, Switch and Tabs `change`), which adds `value` (Tabs: `index`) to its context; prefer one Button in a reply.",
  "An Image takes `accessibility.label` and a `url` that is a base64 PNG, JPEG, GIF or WebP `data:` URL; no other URL is drawn.",
  "A Board draws `columns` (each `{key, title, items}` where `items` is a data path) of one `item` template keyed by `itemKey`; moving items (`move`) is for app plugin pages and is refused here. FilePicker and a Combobox `search` are for app plugin pages too; a Combobox without `search` filters its own options. AgentConfigurationPicker draws the person's own harness and model pickers and is for app plugin pages only; it is refused here. A Dialog and the `change` of a TextField or RichTextEditor are for app plugin pages too and are refused here; a RichTextEditor without `change` and a ListItem whose `action` opens a row are open to agent replies.",
  `Components: ${COMPONENT_NAMES.join(", ")}.`,
  "An invalid spec is answered with each problem's JSON Pointer path; fix them and call again.",
].join("\n")

export const UI_GUIDE_DESCRIPTION =
  "The design guide for ui_show surfaces and app plugin surface pages: principles, layout recipes as valid specs, interaction rules, anti-patterns and a checklist. Read it before building a surface with more than a few components."

export function registerSurfaceTools(registry: ToolRegistrar) {
  registry.tool(
    "ui_show",
    {
      description: UI_SHOW_DESCRIPTION,
      inputSchema: surfaceSpecSchema.shape,
      access: declaredToolAccess({ audiences: ["runtime"], write: false, scope: "read" }),
    },
    async (args) => {
      const checked = checkSurfaceSpec(args, { producer: "agent" })
      if (!checked.ok) return mcpToolRefusal(checked.issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join("\n"))
      const count = checked.spec.components.length
      return toolText(`Shown "${checked.spec.title}" with ${count} ${count === 1 ? "component" : "components"}.`)
    },
  )

  registry.tool(
    "ui_guide",
    {
      description: UI_GUIDE_DESCRIPTION,
      inputSchema: {},
      access: declaredToolAccess({ audiences: ["runtime"], write: false, scope: "read" }),
    },
    async () => toolText(SURFACE_DESIGN_GUIDE),
  )
}
