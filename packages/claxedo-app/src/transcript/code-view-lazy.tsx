import { lazy } from "solid-js"
import { loadChunk } from "@/lib/lazy-view"
import type { SourceDiff as SourceDiffComponent } from "./source-diff"
import type { File as FileComponent } from "./file"
import type { ReviewCodeView as ReviewCodeViewComponent } from "./review-code-view"

export const loadCodeViews = () => Promise.all([import("./file"), import("./source-diff"), import("./review-code-view")])

export const File = lazy<typeof FileComponent>(() => loadChunk(() => import("./file")).then((module) => ({ default: module.File })))

export const SourceDiff = lazy<typeof SourceDiffComponent>(() => loadChunk(() => import("./source-diff")).then((module) => ({ default: module.SourceDiff })))

export const ReviewCodeView = lazy<typeof ReviewCodeViewComponent>(() => loadChunk(() => import("./review-code-view")).then((module) => ({ default: module.ReviewCodeView })))
