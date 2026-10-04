import { lazy, type Component } from "solid-js"

export function lazyView<Props extends Record<string, unknown>>(load: () => Promise<Component<Props>>): Component<Props> {
  return lazy(async () => ({ default: await load() }))
}
