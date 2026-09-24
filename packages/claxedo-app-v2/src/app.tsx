import { QueryClientProvider } from "@tanstack/solid-query"
import type { JSX } from "solid-js"
import { I18nProvider } from "@/i18n"
import { MainSidebar } from "@/rail"
import { ServerContext } from "@/server"
import { AppShell, createShellRegistries, SessionStoresProvider, ShellRegistriesContext, ShellRouter } from "@/shell"
import { createPlaceholderServer } from "@/shell/placeholders/server"
import { firstParty } from "@/shell/registry"
import { DialogProvider, ThemeProvider } from "@/ui"

export function App(): JSX.Element {
  const server = createPlaceholderServer()
  const registries = createShellRegistries(firstParty)
  return (
    <ServerContext.Provider value={server}>
      <QueryClientProvider client={server.queryClient}>
        <SessionStoresProvider server={server}>
          <ShellRegistriesContext.Provider value={registries}>
            <I18nProvider>
              <ThemeProvider>
                <DialogProvider>
                  <ShellRouter>
                    <AppShell mainSidebar={<MainSidebar />} />
                  </ShellRouter>
                </DialogProvider>
              </ThemeProvider>
            </I18nProvider>
          </ShellRegistriesContext.Provider>
        </SessionStoresProvider>
      </QueryClientProvider>
    </ServerContext.Provider>
  )
}
