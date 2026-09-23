import { ComponentProps, For } from "solid-js"

// Pixel-C tile grid (32px pitch). Base coords are the letter skeleton; a +32px
// x-shift optically centres the C against its open right side. Tiles render at
// 33px so neighbours merge into a solid, legible C at any size.
const TILES: readonly [number, number][] = [
  [184, 56], [216, 56], [248, 56], [280, 56], [312, 56],
  [120, 88], [152, 88], [184, 88], [216, 88], [248, 88], [280, 88], [312, 88], [344, 88], [376, 88],
  [88, 120], [120, 120], [152, 120], [184, 120],
  [56, 152], [88, 152], [120, 152], [152, 152],
  [56, 184], [88, 184], [120, 184],
  [56, 216], [88, 216], [120, 216],
  [56, 248], [88, 248], [120, 248],
  [56, 280], [88, 280], [120, 280],
  [56, 312], [88, 312], [120, 312],
  [56, 344], [88, 344], [120, 344], [152, 344],
  [88, 376], [120, 376], [152, 376], [184, 376],
  [120, 408], [152, 408], [184, 408], [216, 408], [248, 408], [280, 408], [312, 408], [344, 408], [376, 408],
  [216, 440], [248, 440], [280, 440], [312, 440],
]
const SHIFT = 32

const CTiles = (props: { fill: string }) => (
  <For each={TILES}>
    {([x, y]) => <rect x={x + SHIFT - 4.5} y={y - 4.5} width={33} height={33} rx={6} fill={props.fill} />}
  </For>
)

export const ClaxedoSplash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="claxedo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="44 44 432 432"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <CTiles fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const ClaxedoLogo = (props: { class?: string }) => {
  return (
    <svg
      data-component="claxedo-logo"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="44 44 432 432"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <CTiles fill="var(--icon-base)" />
    </svg>
  )
}
