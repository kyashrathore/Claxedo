import type { JSX } from "solid-js"
import { Icon, isIconName, type IconName, type IconSize } from "@/ui"

export const fallbackIconName: IconName = "page"

export function iconNameOf(name: string): IconName {
  return isIconName(name) ? name : fallbackIconName
}

export function RegistryIcon(props: { readonly name: string; readonly size?: IconSize }): JSX.Element {
  return <Icon name={iconNameOf(props.name)} size={props.size} />
}
