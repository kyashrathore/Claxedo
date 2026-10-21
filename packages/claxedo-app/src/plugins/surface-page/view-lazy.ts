import { lazyView } from "@/lib/lazy-view"

export const loadPluginSurfaceViews = () => import("./view")

export const PluginSurfacePage = lazyView(() => loadPluginSurfaceViews().then((module) => module.PluginSurfacePage))

export const PluginSurfaceSettings = lazyView(() => loadPluginSurfaceViews().then((module) => module.PluginSurfaceSettings))
