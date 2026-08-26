import {
  Virtualizer,
  elementScroll,
  observeElementOffset,
  observeElementRect,
  observeWindowOffset,
  observeWindowRect,
  windowScroll,
  type VirtualizerOptions,
} from "@tanstack/virtual-core"
import { createEffect, createSignal, merge, onSettled } from "solid-js"

export * from "@tanstack/virtual-core"

function createVirtualizerBase<TScrollElement extends Element | Window, TItemElement extends Element>(
  options: VirtualizerOptions<TScrollElement, TItemElement>,
): Virtualizer<TScrollElement, TItemElement> {
  const resolvedOptions = merge(options)
  const instance = new Virtualizer(resolvedOptions)
  const [virtualItems, setVirtualItems] = createSignal(instance.getVirtualItems(), { equals: false })
  const [totalSize, setTotalSize] = createSignal(instance.getTotalSize())

  const virtualizer = new Proxy(instance, {
    get(target, property) {
      if (property === "getVirtualItems") return () => virtualItems()
      if (property === "getTotalSize") return () => totalSize()
      return Reflect.get(target, property)
    },
  })

  virtualizer.setOptions(resolvedOptions)
  onSettled(() => {
    const cleanup = virtualizer._didMount()
    virtualizer._willUpdate()
    return cleanup
  })

  const resolveVirtualizerOptions = () => {
    const onChange = options.onChange
    return {
      ...resolvedOptions,
      ...options,
      onChange(next: Virtualizer<TScrollElement, TItemElement>, sync: boolean) {
        next._willUpdate()
        setVirtualItems(() => next.getVirtualItems())
        setTotalSize(next.getTotalSize())
        onChange?.(next, sync)
      },
    }
  }
  const applyVirtualizerOptions = (next: VirtualizerOptions<TScrollElement, TItemElement>) => {
    virtualizer.setOptions(next)
    virtualizer._willUpdate()
    setVirtualItems(() => instance.getVirtualItems())
    setTotalSize(instance.getTotalSize())
  }
  createEffect(resolveVirtualizerOptions, applyVirtualizerOptions)

  return virtualizer
}

export function createVirtualizer<TScrollElement extends Element, TItemElement extends Element>(
  options: Omit<
    VirtualizerOptions<TScrollElement, TItemElement>,
    "observeElementRect" | "observeElementOffset" | "scrollToFn"
  > &
    Partial<
      Pick<
        VirtualizerOptions<TScrollElement, TItemElement>,
        "observeElementRect" | "observeElementOffset" | "scrollToFn"
      >
    >,
) {
  return createVirtualizerBase<TScrollElement, TItemElement>(
    merge(
      {
        observeElementRect,
        observeElementOffset,
        scrollToFn: elementScroll,
      },
      options,
    ) as VirtualizerOptions<TScrollElement, TItemElement>,
  )
}

export function createWindowVirtualizer<TItemElement extends Element>(
  options: Omit<
    VirtualizerOptions<Window, TItemElement>,
    "getScrollElement" | "observeElementRect" | "observeElementOffset" | "scrollToFn" | "initialOffset"
  > &
    Partial<
      Pick<
        VirtualizerOptions<Window, TItemElement>,
        "getScrollElement" | "observeElementRect" | "observeElementOffset" | "scrollToFn" | "initialOffset"
      >
    >,
) {
  return createVirtualizerBase<Window, TItemElement>(
    merge(
      {
        getScrollElement: () => (typeof document === "undefined" ? null : window),
        observeElementRect: observeWindowRect,
        observeElementOffset: observeWindowOffset,
        scrollToFn: windowScroll,
        initialOffset: () => (typeof document === "undefined" ? 0 : window.scrollY),
      },
      options,
    ) as VirtualizerOptions<Window, TItemElement>,
  )
}
