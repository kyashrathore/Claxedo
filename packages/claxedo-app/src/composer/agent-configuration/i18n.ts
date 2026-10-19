import { useTranslator, type DomainTranslate, type Translations } from "@/i18n"

type AgentConfigurationKey = "agentConfiguration.harness" | "agentConfiguration.harnessPlaceholder" | "agentConfiguration.model" | "agentConfiguration.modelPlaceholder" | "agentConfiguration.cloudModelsLoading" | "agentConfiguration.cloudNoAccount" | "agentConfiguration.cloudPlanUnlisted" | "agentConfiguration.cloudDefaultModel" | "agentConfiguration.cloudSavedModel" | "agentConfiguration.loadingProjects" | "agentConfiguration.addProjectFirst"

const agentConfigurationDictionary = {
  en: {
    "agentConfiguration.harness": "Harness",
    "agentConfiguration.harnessPlaceholder": "Choose a harness",
    "agentConfiguration.model": "Model",
    "agentConfiguration.modelPlaceholder": "Choose a model",
    "agentConfiguration.cloudModelsLoading": "Loading {{harness}}'s models…",
    "agentConfiguration.cloudNoAccount": "{{harness}} has no account to run a model on. Add one in Settings → Models.",
    "agentConfiguration.cloudPlanUnlisted": "A cloud preset can't run {{harness}} on a ChatGPT plan. Add an OpenAI API key in Settings → Models.",
    "agentConfiguration.cloudDefaultModel": "Runs on {{harness}}'s default model. A harness lists its models only from a running workspace, and a cloud task starts in a new one.",
    "agentConfiguration.cloudSavedModel": "Runs on {{model}}.",
    "agentConfiguration.loadingProjects": "Loading projects…",
    "agentConfiguration.addProjectFirst": "Add a project first: harness and model choices are read from a project's checkout.",
  },
} satisfies Translations<AgentConfigurationKey>

export function useAgentConfigurationText(): DomainTranslate<AgentConfigurationKey> {
  return useTranslator(agentConfigurationDictionary)
}
