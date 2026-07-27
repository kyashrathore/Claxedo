import type { ClaxedoIconProps } from "@/ui/controls/claxedo-icon"
import { ClaxedoIconV2 } from "@/ui/controls/claxedo-icon"

export type TitlebarEditIconProps = Omit<ClaxedoIconProps, "name">

export function TitlebarEditIcon(props: TitlebarEditIconProps) {
  return <ClaxedoIconV2 {...props} name="edit" />
}
