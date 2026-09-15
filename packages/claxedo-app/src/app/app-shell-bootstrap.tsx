import { markRendererPhase } from "@/platform/performance/renderer-trace"
import { createSignal, lazy, onMount, Show, Suspense, type ParentProps } from "solid-js"
import { Toast } from "@opencode-ai/ui/toast"
import { ClaxedoSplash } from "@/ui/controls/claxedo-logo"
import { mainContentReady, markMainContentReady, markShellRevealed } from "@/app/shell-revealed"
import { composerFocus, visibleComposerEditor } from "@/features/session/composer/ui/composer-focus"
import { ClaxedoStateProvider } from "./workbench/state"

trace("runtime.appShellBootstrapEvaluated")

const ClaxedoAppShellInner = lazy(() => {
  return import("./app-shell").then((module) => {
    trace("runtime.appShellInnerEvaluated")
    return { default: module.ClaxedoAppShellInner }
  })
})

/**
 * Boot-only. The splash lives in `BootSplashOverlay`, not this fallback: the
 * boundary resolving is when the shell's chunk arrives, while the draft
 * composer still has its own lazy hops — handing off at resolve painted a
 * blank main region between the two. A later suspension after first content
 * must still show nothing, so this fallback is always the quiet blank.
 */
function ShellSuspenseFallback() {
  return <div class="size-full" />
}

/** The user is looking at the real shell from here on — see shell-revealed.ts. */
function ShellRevealedMarker() {
  onMount(markShellRevealed)
  return null
}

function BootSplashOverlay() {
  const [ready, setReady] = createSignal(mainContentReady())
  onMount(() => {
    // The exact release is a surface's `MainContentReady` marker or a live
    // composer editor; the frame bound only exists so a boot that mounts no
    // known content can never strand the splash.
    let frames = 0
    const tick = () => {
      const editor = visibleComposerEditor(document)
      const rect = editor?.getBoundingClientRect()
      const composerPainted = !!rect && rect.width > 0 && rect.height > 0
      if (mainContentReady() || composerPainted || frames++ >= 600) {
        // Releasing through the composer poll (or the frame bound) is the same
        // fact a marker would have set — record it so a remounted overlay does
        // not replay the splash.
        markMainContentReady()
        setReady(true)
        return
      }
      composerFocus.schedule(tick)
    }
    composerFocus.schedule(tick)
  })
  return (
    <Show when={!ready()}>
      <div class="fixed inset-0 z-[9999] h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
        <ClaxedoSplash class="w-16 h-20 opacity-50" />
      </div>
    </Show>
  )
}

export function ClaxedoAppShell(props: ParentProps) {
  return (
    <ClaxedoStateProvider>
      <Toast.Region />
      <Suspense fallback={<ShellSuspenseFallback />}>
        <ClaxedoAppShellInner>
          <ShellRevealedMarker />
          {props.children}
        </ClaxedoAppShellInner>
      </Suspense>
      <BootSplashOverlay />
    </ClaxedoStateProvider>
  )
}

function trace(name: string) {
  markRendererPhase(name)
}
