import { anyApi, type FunctionReference } from "convex/server"

type ConvexMutation = FunctionReference<"mutation">

type DocumentConvexApi = {
  docs: {
    createForService: ConvexMutation
    appendRevisionForService: ConvexMutation
    listForService: ConvexMutation
    findForService: ConvexMutation
    getRevisionForService: ConvexMutation
    getHeadRevisionForService: ConvexMutation
  }
}

export const documentConvexApi = anyApi as unknown as DocumentConvexApi
