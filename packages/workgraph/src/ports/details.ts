import type {
  AdmissionProposalDto,
  AdmissionProposalReadInputSchema,
  AttemptDetailDto,
  AttemptReadInputSchema,
  DecisionDto,
  DecisionReadInputSchema,
  RecapDto,
  RecapReadInputSchema,
  WorkItemAttemptListInputSchema,
  WorkItemAttemptPage,
  WorkItemDto,
  WorkItemReadInputSchema,
} from "../contracts"
import type { z } from "zod"
import type { OwnerQuery } from "./store"

export type WorkGraphDetailQueries = Readonly<{
  proposals: Readonly<{
    read: OwnerQuery<z.infer<typeof AdmissionProposalReadInputSchema>, AdmissionProposalDto | undefined>
  }>
  workItems: Readonly<{
    readDetail: OwnerQuery<z.infer<typeof WorkItemReadInputSchema>, WorkItemDto | undefined>
    listAttempts: OwnerQuery<z.infer<typeof WorkItemAttemptListInputSchema>, WorkItemAttemptPage>
  }>
  attempts: Readonly<{
    read: OwnerQuery<z.infer<typeof AttemptReadInputSchema>, AttemptDetailDto | undefined>
  }>
  decisions: Readonly<{
    read: OwnerQuery<z.infer<typeof DecisionReadInputSchema>, DecisionDto | undefined>
  }>
  recaps: Readonly<{
    read: OwnerQuery<z.infer<typeof RecapReadInputSchema>, RecapDto | undefined>
  }>
}>
