// Claxedo-only v1 icon glyph overrides.
import { onMount, splitProps, type ComponentProps } from "solid-js"
import { Icon as UpstreamIcon, type IconProps as UpstreamIconProps } from "@opencode-ai/ui/icon"

const claxedoIcons = {
  play: `<path d="M7.08301 5.83268V14.166L14.1663 9.99935L7.08301 5.83268Z" fill="currentColor"/>`,
  worktree: `<path d="M4 10H8L15.5 3.5M12.5 3.5H15.5V6.5M8 10L15.5 16.5M12.5 16.5H15.5V13.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter"/>`,
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
  // Open folder outline used for project headers. Two strokes: the back plate
  // with a left tab, and the open front flap (a forward-leaning trapezoid).
  // Both use currentColor so the icon inherits the header's active/idle color.
  "folder-open": `<path d="M2.5 16V5.5H8L9.5 7.5H16.5V10" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 16H14.5L17.5 10H5.5L2.5 16Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>`,
  // Brand marks (official monochrome logos from @lobehub/icons-static-svg).
  // Both are authored on a 0 0 24 24 grid. Rather than scale to fill the sprite
  // (20/24 → edge-to-edge), we scale the 24-unit art down to ~14 units and
  // centre it (translate 3). These logos are dense and *filled*, so at full
  // size they read much heavier than the thin line glyphs beside them (+, ›,
  // chevron); the extra padding brings their perceived size into line.
  // Filled with currentColor so they inherit the toolbar's idle/hover color.
  claude: `<g transform="translate(3 3) scale(0.583333)"><path fill="currentColor" fill-rule="evenodd" d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></g>`,
  openai: `<g transform="translate(3 3) scale(0.583333)"><path fill="currentColor" fill-rule="evenodd" d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"/></g>`,
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
  const markup = Object.entries(claxedoIcons)
    .map(([name, path]) => `<symbol id="${symbol(name as keyof typeof claxedoIcons)}" viewBox="0 0 20 20">${path}</symbol>`)
    .join("")
  const existing = document.getElementById(spriteID)
  if (existing) {
    // The sprite survives Vite HMR in document.body. Refresh its symbols when
    // this module reloads so changed shared glyphs do not retain stale paths.
    existing.innerHTML = markup
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
  svg.innerHTML = markup
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
