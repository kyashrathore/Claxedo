import { installPluginRuntime } from "../../live/runtime"
import { FRAME_RUNTIME_GLOBAL } from "../protocol"
import { startFrame } from "./start"

installPluginRuntime()
Object.assign(globalThis, { [FRAME_RUNTIME_GLOBAL]: { start: startFrame } })
