import type { JSX } from "solid-js"
import { ClaxedoIcon, type ClaxedoIconName, type ClaxedoIconProps } from "@/ui/controls/claxedo-icon"
import { appIconNames } from "@/ui/icons/catalog"

export const fallbackIconName: ClaxedoIconName = "page"

const known = new Set<string>(appIconNames)

function isIconName(name: string): name is ClaxedoIconName {
  return known.has(name)
}

export function iconNameOf(name: string): ClaxedoIconName {
  return isIconName(name) ? name : fallbackIconName
}

export function RegistryIcon(props: { readonly name: string; readonly size?: ClaxedoIconProps["size"] }): JSX.Element {
  return <ClaxedoIcon name={iconNameOf(props.name)} size={props.size} />
}
