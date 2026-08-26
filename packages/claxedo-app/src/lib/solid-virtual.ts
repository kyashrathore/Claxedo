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
import { createEffect, createSignal, createStore, merge, onSettled, reconcile } from "solid-js"
import type { VirtualItem } from "@tanstack/virtual-core"

export * from "@tanstack/virtual-core"

export type SolidVirtualizer<TScrollElement extends Element | Window, TItemElement extends Element> = Virtualizer<
  TScrollElement,
  TItemElement
> & {
  /**
   * The core's own plain item array, bypassing the reactive store: untracked
   * and trap-free, and current even while a store write is still staged. For
   * event handlers and other imperative readers; tracked scopes must keep
   * reading getVirtualItems().
   */
  peekVirtualItems: () => VirtualItem[]
}

function createVirtualizerBase<TScrollElement extends Element | Window, TItemElement extends Element>(
  options: VirtualizerOptions<TScrollElement, TItemElement>,
): SolidVirtualizer<TScrollElement, TItemElement> {
  const resolvedOptions = merge(options)
  const instance = new Virtualizer(resolvedOptions)
  // Virtual items live in a store reconciled by index, exactly like upstream
  // @tanstack/solid-virtual. Virtual-core fires onChange once per measured row
  // during a cold first-fold mount (~one per visible row), each time minting
  // fresh VirtualItem objects from the first changed index on. Publishing those
  // as a fresh array through a signal woke every row's item memo, the key map,
  // and the <For> diff on every single measurement — O(rows) work, O(rows^2)
  // per cold mount. Reconcile patches fields in place: a row whose start/size
  // did not change wakes nothing.
  const [virtualItems, setVirtualItems] = createStore<VirtualItem[]>(instance.getVirtualItems())
  // ownedWrite: publish() runs from the options effect and from virtual-core's
  // onChange during mounted computations - both intentional owned-scope writes.
  const [totalSize, setTotalSize] = createSignal(instance.getTotalSize(), { ownedWrite: true })
  const publish = (source: Virtualizer<TScrollElement, TItemElement>) => {
    setVirtualItems(reconcile(source.getVirtualItems(), "index"))
    setTotalSize(source.getTotalSize())
  }

  const virtualizer = new Proxy(instance, {
    get(target, property) {
      if (property === "getVirtualItems") return () => virtualItems
      if (property === "getTotalSize") return () => totalSize()
      if (property === "peekVirtualItems") return () => target.getVirtualItems()
      return Reflect.get(target, property)
    },
  }) as SolidVirtualizer<TScrollElement, TItemElement>

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
        publish(next)
        onChange?.(next, sync)
      },
    }
  }
  const applyVirtualizerOptions = (next: VirtualizerOptions<TScrollElement, TItemElement>) => {
    virtualizer.setOptions(next)
    virtualizer._willUpdate()
    publish(instance)
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
