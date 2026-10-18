import { lazy } from "solid-js"
import { loadFilesNavigator } from "@/files"
import { loadChunk } from "@/lib/lazy-view"
import { loadSourceControlView } from "@/review"
import type { PanelBody as PanelBodyComponent } from "./panel-body"

export const loadPanelBody = () => Promise.all([import("./panel-body"), loadFilesNavigator(), loadSourceControlView()])

export const PanelBody = lazy<typeof PanelBodyComponent>(() => loadChunk(() => import("./panel-body")).then((module) => ({ default: module.PanelBody })))
