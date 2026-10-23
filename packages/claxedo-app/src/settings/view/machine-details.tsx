import { Show } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useTranslator } from "@/i18n"
import { useServer, type Machine, type MachineEnrollment } from "@/server"
import { Drawer, useDialog } from "@/ui"
import { settingsDictionary } from "../i18n"
import { createMachineCheck } from "../machines"
import { MachineActions } from "./machine-actions"
import { CheckReport } from "./machine-check"
import { RenameMachine } from "./machine-rename"
import { BlockedNotice, MachineFacts } from "./machine-report"
import { SharedFolders } from "./machine-roots"
import { MachineStatus } from "./machine-status"

function MachineManagement(props: { readonly machine: Machine; readonly enrollment: MachineEnrollment; readonly onChanged: () => void }) {
  return (
    <>
      <MachineFacts name={props.machine.name} enrollment={props.enrollment} />
      <RenameMachine name={props.machine.name} enrollment={props.enrollment} />
      <Show when={props.enrollment.roots}>{(roots) => <SharedFolders name={props.machine.name} enrollment={props.enrollment} roots={roots()} />}</Show>
      <MachineActions machine={props.machine} enrollment={props.enrollment} onChanged={props.onChanged} />
    </>
  )
}

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
        <Show when={listed()?.enrollment?.blocked}>{(block) => <BlockedNotice name={name()} block={block()} />}</Show>
        <CheckReport check={check.state()} name={name()} onRetry={check.retry} />
        <Show when={listed()}>
          {(machine) => (
            <Show when={machine().enrollment}>{(enrollment) => <MachineManagement machine={machine()} enrollment={enrollment()} onChanged={check.retry} />}</Show>
          )}
        </Show>
      </div>
    </Drawer>
  )
}
