import { Type } from "@earendil-works/pi-ai"
import { defineTool } from "@earendil-works/pi-durable"
import { questionRequest, requestQuestionAnswers } from "../../contract"
import type { PiAsker } from "./approvals"

const parameters = Type.Object({
  question: Type.String({ description: "The question to ask the person" }),
  options: Type.Optional(Type.Array(Type.String(), { description: "Answers the person can pick from; they may also write their own" })),
})

export function piQuestionTool(input: { sessionId: string; asker: () => PiAsker }) {
  return defineTool({
    name: "question",
    description: "Ask the person a question and wait for their answer. Use it only when you cannot proceed without their decision.",
    parameters,
    async execute(args, api, context) {
      const answer = await input.asker().ask(questionRequest({
        requestId: `pi-question:${api.callId}`, sessionId: input.sessionId,
        questions: [{ header: "Pi", question: args.question, custom: true,
          options: (args.options ?? []).map((label) => ({ label, description: "" })) }],
      }), context.abortSignal ? { signal: context.abortSignal } : undefined)
      const answers = requestQuestionAnswers(answer)?.[0]
      return { content: [{ type: "text", text: answers?.length ? answers.join(", ") : "The person did not answer" }],
        ...(answers?.length ? {} : { isError: true }) }
    },
  })
}
