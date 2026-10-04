import type { JSX } from "solid-js"
import { ClaxedoIcon, type ClaxedoIconName, type ClaxedoIconProps, appIconNames } from "@/ui"

export const fallbackIconName: ClaxedoIconName = "page"

function isAppIconName(name: string): name is ClaxedoIconName {
  return (appIconNames as readonly string[]).includes(name)
}

export function iconNameOf(name: string): ClaxedoIconName {
  return isAppIconName(name) ? name : fallbackIconName
}

export function RegistryIcon(props: { readonly name: string; readonly size?: ClaxedoIconProps["size"] }): JSX.Element {
  return <ClaxedoIcon name={iconNameOf(props.name)} size={props.size} />
}
