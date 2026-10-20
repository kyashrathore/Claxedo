/** The one header a backend's request carries about its caller: an opaque handle it resolves through `env.PLATFORM.caller`. */
export const PLUGIN_CALLER_HEADER = "x-claxedo-caller"

/** The name the backend gave `env.PLATFORM.object`, set on every request a facet receives. */
export const PLUGIN_OBJECT_NAME_HEADER = "x-claxedo-object-name"
