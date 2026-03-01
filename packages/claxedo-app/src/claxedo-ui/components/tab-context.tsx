import { SessionContextTab } from "@/components/session"

export function TabContext(_props: { sessionId: string }) {
  return (
    <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
      <SessionContextTab />
    </div>
  )
}
