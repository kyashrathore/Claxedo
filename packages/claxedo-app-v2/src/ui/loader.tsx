import { splitProps, type ComponentProps } from "solid-js"
import "./loader.css"

export function Loader(props: ComponentProps<"svg">) {
  const [local, rest] = splitProps(props, ["class", "classList", "width", "height"])
  return (
    <svg
      {...rest}
      class={local.class}
      classList={{ "v2-loader": true, ...(local.classList) }}
      width={local.width ?? 16}
      height={local.height ?? 16}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-component="v2-loader"
      aria-hidden={rest["aria-hidden"] ?? "true"}
    >
      <circle cx="8" cy="8" r="6" data-slot="v2-loader-background" stroke-width="2" />
      <circle
        cx="8"
        cy="8"
        r="6"
        data-slot="v2-loader-progress"
        pathLength="100"
        stroke-width="2"
        stroke-dasharray="33 67"
      />
    </svg>
  )
}
