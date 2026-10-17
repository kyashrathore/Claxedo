import type { SURFACE_ICON_NAMES } from "@claxedo/plugin-api/surface"
import type { IconProps } from "@/ui"

export type SurfaceIconName = (typeof SURFACE_ICON_NAMES)[number]

const ICONS_BY_NAME: Readonly<Record<SurfaceIconName, IconProps["name"]>> = {
  accountCircle: "subagent",
  add: "plus",
  arrowBack: "arrow-left",
  arrowForward: "arrow-right",
  attachFile: "link",
  calendarToday: "checklist",
  call: "speech-bubble",
  camera: "photo",
  check: "check",
  close: "close",
  delete: "trash",
  download: "download",
  edit: "edit",
  event: "checklist",
  error: "circle-x",
  fastForward: "chevron-double-right",
  favorite: "bolt",
  favoriteOff: "circle-dashed",
  folder: "folder",
  help: "help",
  home: "layout-left",
  info: "circle-alert",
  locationOn: "status",
  lock: "shield",
  lockOpen: "shield",
  mail: "speech-bubble",
  menu: "menu",
  moreVert: "three-dots",
  moreHoriz: "three-dots",
  notificationsOff: "circle-ban-sign",
  notifications: "circle-alert",
  pause: "stop",
  payment: "archive",
  person: "subagent",
  phone: "speech-bubble",
  photo: "photo",
  play: "chevron-right",
  print: "document-text",
  refresh: "reset",
  rewind: "chevron-double-left",
  search: "magnifying-glass",
  send: "arrow-up",
  settings: "settings-gear",
  share: "share",
  shoppingCart: "archive",
  skipNext: "chevron-double-right",
  skipPrevious: "chevron-double-left",
  star: "bolt",
  starHalf: "circle-half",
  starOff: "circle-dashed",
  stop: "stop",
  upload: "cloud-upload",
  visibility: "eye",
  visibilityOff: "circle-ban-sign",
  volumeDown: "sliders",
  volumeMute: "sliders",
  volumeOff: "sliders",
  volumeUp: "sliders",
  warning: "warning",
}

function isSurfaceIconName(name: unknown): name is SurfaceIconName {
  return typeof name === "string" && Object.hasOwn(ICONS_BY_NAME, name)
}

export function surfaceIcon(name: unknown): IconProps["name"] | undefined {
  return isSurfaceIconName(name) ? ICONS_BY_NAME[name] : undefined
}
