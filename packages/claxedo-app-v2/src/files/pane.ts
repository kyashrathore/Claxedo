import { placementId as toPlacementId } from "@/server"
import type { Json, PaneKind } from "@/shell/types"
import type { FilePaneState } from "./model"
import { basename } from "./path"
import { FilePane } from "./view/file-pane"

export const FILE_PANE_KIND = "file"

function optionalNumber(value: Json | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined
}

function isJsonObject(value: Json): value is { readonly [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function decodeFilePaneState(value: Json): FilePaneState | undefined {
  if (!isJsonObject(value)) return undefined
  const placement = value.placementId
  const path = value.path
  if (typeof placement !== "string" || typeof path !== "string" || !placement || !path) return undefined
  const line = optionalNumber(value.line)
  const col = optionalNumber(value.col)
  return {
    placementId: toPlacementId(placement),
    path,
    ...(line === undefined ? {} : { line }),
    ...(col === undefined ? {} : { col }),
  }
}

export const filePaneKind: PaneKind<FilePaneState> = {
  kind: FILE_PANE_KIND,
  title: (state) => basename(state.path),
  icon: "file",
  view: FilePane,
  encode: (state) => ({
    placementId: state.placementId,
    path: state.path,
    ...(state.line === undefined ? {} : { line: state.line }),
    ...(state.col === undefined ? {} : { col: state.col }),
  }),
  decode: decodeFilePaneState,
}
