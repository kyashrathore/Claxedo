import { lazy } from "solid-js"
import { loadChunk } from "@/lib/lazy-view"
import type { SessionDocks as SessionDocksComponent } from "./session-docks"

export const loadSessionDocks = () => import("./session-docks")

export const SessionDocks = lazy<typeof SessionDocksComponent>(() => loadChunk(loadSessionDocks).then((module) => ({ default: module.SessionDocks })))
