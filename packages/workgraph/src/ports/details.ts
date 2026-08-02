import type {
  AdmissionProposalDto,
  AdmissionProposalReadInputSchema,
  RunDetailDto,
  RunReadInputSchema,
  DecisionDto,
  DecisionReadInputSchema,
  WorkItemRunListInputSchema,
  WorkItemRunPage,
  WorkItemDto,
  WorkItemReadInputSchema,
  TaskActivityListInput,
  TaskActivityPage,
} from "../contracts"
import type { z } from "zod"
import type { OwnerQuery } from "./store"

export type WorkGraphDetailQueries = Readonly<{
  proposals: Readonly<{
    read: OwnerQuery<z.infer<typeof AdmissionProposalReadInputSchema>, AdmissionProposalDto | undefined>
  }>
  workItems: Readonly<{
    readDetail: OwnerQuery<z.infer<typeof WorkItemReadInputSchema>, WorkItemDto | undefined>
    listRuns: OwnerQuery<z.infer<typeof WorkItemRunListInputSchema>, WorkItemRunPage>
    listActivity: OwnerQuery<TaskActivityListInput, TaskActivityPage>
  }>
  runs: Readonly<{
    read: OwnerQuery<z.infer<typeof RunReadInputSchema>, RunDetailDto | undefined>
  }>
  decisions: Readonly<{
    read: OwnerQuery<z.infer<typeof DecisionReadInputSchema>, DecisionDto | undefined>
  }>
}>
