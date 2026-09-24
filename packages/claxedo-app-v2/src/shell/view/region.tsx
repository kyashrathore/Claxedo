import type { JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { FailureBoundary } from "@/lib/failure"
import { dictionary } from "../i18n"

export type RegionName = "sidebar" | "center" | "panel" | "page" | "overlay"

export function Region(props: { readonly name: RegionName; readonly children: JSX.Element }): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <FailureBoundary
      title={t("shell.regionFailed", { region: t(`shell.region.${props.name}`) })}
      retryLabel={t("shell.retry")}
      onError={(error) => console.error(`Shell region ${props.name} failed`, error)}
    >
      {props.children}
    </FailureBoundary>
  )
}
