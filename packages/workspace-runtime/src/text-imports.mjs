import { register } from "node:module"

register(new URL("./text-imports-loader.mjs", import.meta.url))
