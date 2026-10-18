import { z } from "zod"

export const SURFACE_CATALOG_ID = "https://claxedo.dev/a2ui/v0.9/catalog.json"

export const SURFACE_ICON_NAMES = [
  "accountCircle", "add", "arrowBack", "arrowForward", "calendarToday", "check", "close", "delete", "download", "edit",
  "event", "error", "fastForward", "favorite", "favoriteOff", "folder", "help", "home", "info", "locationOn", "lock",
  "lockOpen", "mail", "menu", "moreVert", "moreHoriz", "notificationsOff", "notifications", "pause", "payment", "person",
  "photo", "play", "refresh", "rewind", "search", "send", "settings", "share", "shoppingCart", "skipNext", "skipPrevious",
  "star", "starOff", "stop", "upload", "visibility", "visibilityOff", "warning",
] as const

const MAX_TEXT = 100_000

export const dataBindingSchema = z.object({ path: z.string().max(1024) }).strict().meta({ id: "DataBinding" })
const dynamicString = z.union([z.string().max(MAX_TEXT), dataBindingSchema]).meta({ id: "DynamicString" })
const dynamicNumber = z.union([z.number(), dataBindingSchema]).meta({ id: "DynamicNumber" })
const dynamicBoolean = z.union([z.boolean(), dataBindingSchema]).meta({ id: "DynamicBoolean" })
const dynamicStringList = z.union([z.array(z.string()), dataBindingSchema]).meta({ id: "DynamicStringList" })
const dynamicValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.json()), dataBindingSchema]).meta({ id: "DynamicValue" })
const componentId = z.string().min(1).max(256).meta({ id: "ComponentId" })
const componentIdList = z.array(componentId).meta({ id: "ComponentIdList" })
const iconName = z.enum(SURFACE_ICON_NAMES).meta({ id: "IconName" })
const keyValueItem = z.object({ label: dynamicString, value: dynamicString }).strict().meta({ id: "KeyValueItem" })
const childList = z.union([
  z.array(componentId),
  z.object({ componentId, path: z.string().max(1024) }).strict(),
]).meta({ id: "ChildList" })

export const surfaceActionSchema = z
  .object({
    event: z.object({ name: z.string().min(1).max(256), context: z.record(z.string(), dynamicValue).optional() }).strict(),
  })
  .strict()
  .meta({ id: "Action" })

const common = {
  id: componentId,
  accessibility: z.object({ label: dynamicString.optional(), description: dynamicString.optional() }).strict().meta({ id: "Accessibility" }).optional(),
  weight: z.number().nonnegative().optional(),
}

function catalogComponent<Name extends string, Shape extends z.ZodRawShape>(name: Name, shape: Shape) {
  return z.object({ ...common, component: z.literal(name), ...shape }).strict()
}

export const SURFACE_BADGE_TONES = ["neutral", "accent", "success", "warning", "danger"] as const
const badgeTone = z.enum(SURFACE_BADGE_TONES).meta({ id: "BadgeTone" })

const justify = z.enum(["start", "center", "end", "spaceBetween", "spaceAround", "spaceEvenly", "stretch"]).meta({ id: "Justify" })
const align = z.enum(["start", "center", "end", "stretch"]).meta({ id: "Align" })

export const surfaceComponentSchema = z.discriminatedUnion("component", [
  catalogComponent("Text", { text: dynamicString, variant: z.enum(["h1", "h2", "h3", "h4", "h5", "caption", "body"]).optional() }),
  catalogComponent("Markdown", { text: dynamicString }),
  catalogComponent("Code", { text: dynamicString, language: z.string().max(64).optional() }),
  catalogComponent("Icon", { name: z.union([iconName, dataBindingSchema]) }),
  catalogComponent("Badge", { text: dynamicString, variant: z.union([badgeTone, dataBindingSchema]).optional() }),
  catalogComponent("Link", { text: dynamicString, url: dynamicString }),
  catalogComponent("Row", { children: childList, justify: justify.optional(), align: align.optional() }),
  catalogComponent("Column", { children: childList, justify: justify.optional(), align: align.optional() }),
  catalogComponent("List", { children: childList, direction: z.enum(["vertical", "horizontal"]).optional(), align: align.optional() }),
  catalogComponent("Card", { child: componentId }),
  catalogComponent("Tabs", { tabs: z.array(z.object({ title: dynamicString, child: componentId }).strict()).min(1) }),
  catalogComponent("Collapsible", { title: dynamicString, child: componentId, open: z.boolean().optional() }),
  catalogComponent("Divider", { axis: z.enum(["horizontal", "vertical"]).optional() }),
  catalogComponent("Button", {
    child: componentId,
    variant: z.enum(["default", "primary", "borderless"]).optional(),
    icon: z.union([iconName, dataBindingSchema]).optional(),
    action: surfaceActionSchema,
  }),
  catalogComponent("TextField", {
    label: dynamicString,
    value: dynamicString.optional(),
    variant: z.enum(["longText", "number", "shortText", "obscured"]).optional(),
    validationRegexp: z.string().max(1024).optional(),
  }),
  catalogComponent("CheckBox", { label: dynamicString, value: dynamicBoolean }),
  catalogComponent("Switch", { label: dynamicString, value: dynamicBoolean }),
  catalogComponent("ChoicePicker", {
    label: dynamicString.optional(),
    variant: z.enum(["multipleSelection", "mutuallyExclusive"]).optional(),
    options: z.array(z.object({ label: dynamicString, value: z.string() }).strict()).min(1),
    value: dynamicStringList,
    displayStyle: z.enum(["checkbox", "chips", "dropdown"]).optional(),
  }),
  catalogComponent("Slider", { label: dynamicString.optional(), min: z.number().optional(), max: z.number(), step: z.number().positive().optional(), value: dynamicNumber }),
  catalogComponent("DateTimeInput", {
    value: dynamicString,
    enableDate: z.boolean().optional(),
    enableTime: z.boolean().optional(),
    min: dynamicString.optional(),
    max: dynamicString.optional(),
    label: dynamicString.optional(),
  }),
  catalogComponent("Progress", { value: dynamicNumber, max: z.number().positive().optional(), label: dynamicString.optional() }),
  catalogComponent("Spinner", { label: dynamicString.optional() }),
  catalogComponent("Table", {
    columns: z.array(z.object({ key: z.string().min(1), title: dynamicString }).strict()).min(1),
    rows: z.union([z.array(z.record(z.string(), z.json())), dataBindingSchema]),
  }),
  catalogComponent("DiffStat", { additions: dynamicNumber, deletions: dynamicNumber }),
  catalogComponent("EmptyState", { title: dynamicString, description: dynamicString.optional() }),
  catalogComponent("Header", {
    title: dynamicString,
    subtitle: dynamicString.optional(),
    icon: iconName.optional(),
    badges: componentIdList.optional(),
    actions: componentIdList.optional(),
  }),
  catalogComponent("Section", {
    title: dynamicString.optional(),
    description: dynamicString.optional(),
    actions: componentIdList.optional(),
    child: componentId,
    variant: z.enum(["card", "plain"]).optional(),
  }),
  catalogComponent("Stat", {
    label: dynamicString,
    value: dynamicString,
    delta: dynamicString.optional(),
    tone: z.enum(["neutral", "positive", "negative", "warning"]).optional(),
    caption: dynamicString.optional(),
  }),
  catalogComponent("Grid", { children: childList, columns: z.number().int().min(1).max(6).optional(), gap: z.enum(["small", "medium", "large"]).optional() }),
  catalogComponent("ListItem", {
    title: dynamicString,
    subtitle: dynamicString.optional(),
    icon: z.union([iconName, dataBindingSchema]).optional(),
    meta: componentIdList.optional(),
    primaryAction: componentId.optional(),
    actions: componentIdList.optional(),
    selected: dynamicBoolean.optional(),
  }),
  catalogComponent("Callout", {
    tone: z.enum(["info", "success", "warning", "danger"]),
    title: dynamicString,
    text: dynamicString.optional(),
    action: componentId.optional(),
    dismissible: z.boolean().optional(),
  }),
  catalogComponent("Footer", { start: componentIdList.optional(), end: componentIdList }),
  catalogComponent("KeyValue", { items: z.union([z.array(keyValueItem), dataBindingSchema]) }),
])

export type SurfaceComponent = z.infer<typeof surfaceComponentSchema>
export type SurfaceComponentName = SurfaceComponent["component"]
export type SurfaceDataBinding = z.infer<typeof dataBindingSchema>
export type SurfaceActionDefinition = z.infer<typeof surfaceActionSchema>
export type SurfaceChildList = z.infer<typeof childList>
export type SurfaceDynamicValue = z.infer<typeof dynamicValue>
