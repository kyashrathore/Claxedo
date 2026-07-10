// target-layer: claxedo-ui/components - Claxedo-only v1 icon glyph overrides.
import { onMount, splitProps, type ComponentProps } from "solid-js"
import { Icon as UpstreamIcon, type IconProps as UpstreamIconProps } from "@opencode-ai/ui/icon"

const claxedoIcons = {
  play: `<path d="M7.08301 5.83268V14.166L14.1663 9.99935L7.08301 5.83268Z" fill="currentColor"/>`,
  worktree: `<path d="M4.16699 4.58301V13.333C4.16699 14.7137 5.28628 15.833 6.66699 15.833H8.33366M4.16699 8.33301H7.08366C8.46437 8.33301 9.58366 9.4523 9.58366 10.833V11.6663" stroke="currentColor" stroke-linecap="square"/><path d="M10.417 10.417H13.1253L13.9587 11.667H17.0837V16.2503H10.417V10.417Z" stroke="currentColor" stroke-linejoin="round"/><circle cx="4.16699" cy="4.58301" r="1.25" fill="currentColor"/>`,
  "file-tree": `<path d="M4.58203 16.6693L6.66536 9.58594H17.082M4.58203 16.6693H16.457L18.5404 9.58594H17.082M4.58203 16.6693H2.08203V3.33594H8.33203L9.9987 5.83594H17.082V9.58594" stroke="currentColor" stroke-linecap="round"/>`,
  "file-tree-active": `<path d="M6.66536 9.58594L4.58203 16.6693H16.457L18.5404 9.58594H17.082H6.66536Z" fill="currentColor" fill-opacity="16%"/><path d="M4.58203 16.6693L6.66536 9.58594H17.082M4.58203 16.6693H16.457L18.5404 9.58594H17.082M4.58203 16.6693H2.08203V3.33594H8.33203L9.9987 5.83594H17.082V9.58594" stroke="currentColor" stroke-linecap="round"/>`,
  "new-session": `<path d="M17.0827 17.0807V17.5807H17.5827V17.0807H17.0827ZM2.91602 17.0807H2.41602L2.41602 17.5807H2.91602L2.91602 17.0807ZM2.91602 2.91406V2.41406H2.41602V2.91406H2.91602ZM9.58268 3.41406H10.0827V2.41406L9.58268 2.41406V2.91406V3.41406ZM17.5827 10.4141V9.91406L16.5827 9.91406V10.4141H17.0827H17.5827ZM6.24935 11.2474L5.8958 10.8938L5.74935 11.0403V11.2474H6.24935ZM6.24935 13.7474H5.74935V14.2474H6.24935V13.7474ZM8.74935 13.7474V14.2474H8.95646L9.1029 14.101L8.74935 13.7474ZM15.2077 2.28906L15.5612 1.93551L15.2077 1.58196L14.8541 1.93551L15.2077 2.28906ZM17.7077 4.78906L18.0612 5.14262L18.4148 4.78906L18.0612 4.43551L17.7077 4.78906ZM17.0827 17.0807V16.5807H2.91602V17.0807L2.91602 17.5807H17.0827V17.0807ZM2.91602 17.0807H3.41602L3.41602 2.91406H2.91602H2.41602L2.41602 17.0807H2.91602ZM2.91602 2.91406V3.41406L9.58268 3.41406V2.91406V2.41406L2.91602 2.41406V2.91406ZM17.0827 10.4141H16.5827V17.0807H17.0827H17.5827V10.4141H17.0827ZM6.24935 11.2474H5.74935V13.7474H6.24935H6.74935V11.2474H6.24935ZM6.24935 13.7474V14.2474L8.74935 14.2474V13.7474V13.2474L6.24935 13.2474V13.7474ZM6.24935 11.2474L6.6029 11.6009L15.5612 2.64262L15.2077 2.28906L14.8541 1.93551L5.8958 10.8938L6.24935 11.2474ZM15.2077 2.28906L14.8541 2.64262L17.3541 5.14262L17.7077 4.78906L18.0612 4.43551L15.5612 1.93551L15.2077 2.28906ZM17.7077 4.78906L17.3541 4.43551L8.3958 13.3938L8.74935 13.7474L9.1029 14.101L18.0612 5.14262L17.7077 4.78906Z" fill="currentColor"/>`,
  "file-text": `<path d="M12.5 2.08325H5.41667V17.9166H14.5833V4.16658M12.5 2.08325L14.5833 4.16658M12.5 2.08325V4.16658H14.5833M7.5 8.33325H12.5M7.5 11.6666H12.5M7.5 14.9999H10" stroke="currentColor" stroke-linecap="square"/>`,
  pin: `<path d="M6.667 10.417H13.333M8.333 10.417V5H11.667V10.417M10 10.417V16.667" stroke="currentColor" stroke-linecap="square"/>`,
  kebab: `<circle cx="10" cy="5" r="2" fill="currentColor"/><circle cx="10" cy="10" r="2" fill="currentColor"/><circle cx="10" cy="15" r="2" fill="currentColor"/>`,
  "more-horizontal": `<circle cx="5" cy="10" r="1.6" fill="currentColor"/><circle cx="10" cy="10" r="1.6" fill="currentColor"/><circle cx="15" cy="10" r="1.6" fill="currentColor"/>`,
  globe: `<path d="M17.9163 9.9987C17.9163 14.371 14.3719 17.9154 9.99967 17.9154C5.62742 17.9154 2.08301 14.371 2.08301 9.9987C2.08301 5.62644 5.62742 2.08203 9.99967 2.08203C14.3719 2.08203 17.9163 5.62644 17.9163 9.9987Z" stroke="currentColor"/><path d="M2.5 9.99935H17.5" stroke="currentColor" stroke-linecap="square"/><path d="M9.99967 2.08203C12.1071 4.16666 13.3327 7.0026 13.3327 9.9987C13.3327 12.9948 12.1071 15.8307 9.99967 17.9154C7.89225 15.8307 6.66634 12.9948 6.66634 9.9987C6.66634 7.0026 7.89225 4.16666 9.99967 2.08203Z" stroke="currentColor"/>`,
  cloud: `<path d="M15 15.4167H5.83333C3.30203 15.4167 1.25 13.5646 1.25 11.25C1.25 9.34892 2.84892 7.48794 4.96501 7.08214C5.76101 5.08114 7.71532 3.66667 10 3.66667C12.8586 3.66667 15.2 5.71436 15.4025 8.35467C17.2843 8.5555 18.75 10.1482 18.75 12.0833C18.75 14.1544 17.0711 15.4167 15 15.4167Z" stroke="currentColor" stroke-linecap="square"/>`,
  laptop: `<path d="M3.33333 13.3333V5C3.33333 4.07953 4.07953 3.33333 5 3.33333H15C15.9205 3.33333 16.6667 4.07953 16.6667 5V13.3333M1.66667 15H18.3333C18.3333 14.0795 17.5871 13.3333 16.6667 13.3333H3.33333C2.41286 13.3333 1.66667 14.0795 1.66667 15Z" stroke="currentColor" stroke-linecap="square"/>`,
  reload: `<path d="M16.25 6.66667C14.95 4.66667 12.65 3.33333 10 3.33333C6.31667 3.33333 3.33333 6.31667 3.33333 10C3.33333 13.6833 6.31667 16.6667 10 16.6667C13.05 16.6667 15.6 14.6167 16.4333 11.8333" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M16.6667 2.5V6.66667H12.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>`,
  page: `<path d="M5 2.5H12.5L15.8333 5.83333V17.5H5V2.5Z" stroke="currentColor" stroke-linecap="square"/><path d="M12.5 2.5V5.83333H15.8333" stroke="currentColor" stroke-linecap="square"/><path d="M7.5 9.16667H12.9167M7.5 11.6667H12.9167M7.5 14.1667H10.8333" stroke="currentColor" stroke-linecap="square"/>`,
  gauge: `<path d="M3.33333 15C2.5 13.6111 2.08333 11.9444 2.08333 10.2778C2.08333 5.90279 5.625 2.36112 10 2.36112C14.375 2.36112 17.9167 5.90279 17.9167 10.2778C17.9167 11.9444 17.5 13.6111 16.6667 15" stroke="currentColor" stroke-linecap="round"/><path d="M10 10.2778L13.3333 6.94446" stroke="currentColor" stroke-linecap="round"/><circle cx="10" cy="10.2778" r="1.25" fill="currentColor"/>`,
}

export type ClaxedoIconName = UpstreamIconProps["name"] | keyof typeof claxedoIcons

export interface ClaxedoIconProps extends Omit<UpstreamIconProps, "name"> {
  name: ClaxedoIconName
}

const spriteID = "claxedo-icon-sprite"
const symbol = (name: keyof typeof claxedoIcons) => `claxedo-icon-${name}`
let spriteInserted = false

function hasClaxedoIcon(name: ClaxedoIconName): name is keyof typeof claxedoIcons {
  return name in claxedoIcons
}

function ensureSprite() {
  if (spriteInserted) return
  if (typeof document === "undefined") return
  if (document.getElementById(spriteID)) {
    spriteInserted = true
    return
  }
  const body = document.body as HTMLElement | null
  if (!body) return

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.id = spriteID
  svg.setAttribute("aria-hidden", "true")
  svg.setAttribute("width", "0")
  svg.setAttribute("height", "0")
  svg.style.position = "absolute"
  svg.style.overflow = "hidden"
  svg.innerHTML = Object.entries(claxedoIcons)
    .map(([name, path]) => `<symbol id="${symbol(name as keyof typeof claxedoIcons)}" viewBox="0 0 20 20">${path}</symbol>`)
    .join("")
  body.insertBefore(svg, body.firstChild)
  spriteInserted = true
}

export function ClaxedoIcon(props: ClaxedoIconProps) {
  if (!hasClaxedoIcon(props.name)) return <UpstreamIcon {...props as UpstreamIconProps} />

  const name = props.name
  const [local, others] = splitProps(props, ["name", "size", "class", "classList"])
  onMount(ensureSprite)

  return (
    <div data-component="icon" data-icon={name} data-size={local.size || "normal"}>
      <svg
        data-slot="icon-svg"
        classList={{
          ...local.classList,
          [local.class ?? ""]: !!local.class,
        }}
        fill="none"
        viewBox="0 0 20 20"
        aria-hidden="true"
        {...others as ComponentProps<"svg">}
      >
        <use href={`#${symbol(name)}`} />
      </svg>
    </div>
  )
}
