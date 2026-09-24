import { createUniqueId, For, type ComponentProps } from "solid-js"

const cell = 240 / 13
const pitch = cell * 5
const top = 18

const letters: Record<string, readonly string[]> = {
  C: ["####", "#...", "#...", "#...", "####"],
  L: ["#...", "#...", "#...", "#...", "####"],
  A: ["####", "#..#", "####", "#..#", "#..#"],
  X: ["#..#", "#..#", ".##.", "#..#", "#..#"],
  E: ["####", "#..#", "####", "#...", "####"],
  D: ["####", "#..#", "#..#", "#..#", "####"],
  O: ["####", "#..#", "#..#", "#..#", "####"],
}

const word = "CLAXEDO"

const cells = [...word].flatMap((letter, index) =>
  letters[letter].flatMap((row, y) =>
    [...row].flatMap((pixel, x) => (pixel === "#" ? [{ x: index * pitch + x * cell, y: top + y * cell }] : [])),
  ),
)

const width = Math.round(word.length * pitch - cell)

export function Wordmark(props: Pick<ComponentProps<"svg">, "class">) {
  const mask = createUniqueId()
  const gradient = createUniqueId()
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${width} 129`}
      fill="none"
      role="img"
      aria-label="Claxedo"
      data-component="v2-wordmark"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g opacity="0.6" mask={`url(#${mask})`}>
        <g opacity="0.16" fill="currentColor">
          <For each={cells}>{(pixel) => <rect x={pixel.x} y={pixel.y} width={cell} height={cell} opacity="0.7" />}</For>
        </g>
      </g>
      <defs>
        <mask id={mask} style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width={width} height="129">
          <rect width={width} height="129" fill={`url(#${gradient})`} />
        </mask>
        <linearGradient id={gradient} x1={width / 2} y1="68" x2={width / 2} y2="129" gradientUnits="userSpaceOnUse">
          <stop stop-color="white" stop-opacity="0.7" />
          <stop offset="1" stop-color="white" stop-opacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}
