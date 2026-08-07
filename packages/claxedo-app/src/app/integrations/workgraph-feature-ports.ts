import { configureWorkGraphAppPorts } from "@/features/workgraph/app-ports"
import { useClaxedoEventsOptional } from "@/app/integrations/claxedo-events"

configureWorkGraphAppPorts({ useClaxedoEventsOptional })
