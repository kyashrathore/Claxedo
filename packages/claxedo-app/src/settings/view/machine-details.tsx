import { Show } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useTranslator } from "@/i18n"
import { useServer } from "@/server"
import { Drawer, useDialog } from "@/ui"
import { settingsDictionary } from "../i18n"
import { createMachineCheck } from "../machines"
import { MachineActions } from "./machine-actions"
import { CheckReport } from "./machine-check"
import { MachineStatus } from "./machine-status"

export function MachineDetails(props: { readonly hostId: string; readonly name: string }) {
  const t = useTranslator(settingsDictionary)
  const dialog = useDialog()
  const server = useServer()
  const query = useQuery(() => server.queries.machines.list())
  const listed = () => query.data?.find((machine) => machine.enrollment?.hostId === props.hostId)
  const name = () => listed()?.name ?? props.name
  const check = createMachineCheck(server.machines, props.hostId)
  return (
    <Drawer title={name()} description={<Show when={listed()}>{(machine) => <MachineStatus machine={machine()} />}</Show>} closeLabel={t("settings.machines.connect.done")} onClose={() => dialog.close()}>
      <div class="settings-machine-details">
        <CheckReport check={check.state()} name={name()} onRetry={check.retry} />
        <Show when={listed()}>
          {(machine) => (
            <Show when={machine().enrollment}>{(enrollment) => <MachineActions machine={machine()} enrollment={enrollment()} onChanged={check.retry} />}</Show>
          )}
        </Show>
      </div>
    </Drawer>
  )
}
