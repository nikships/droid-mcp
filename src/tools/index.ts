import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Effect from "effect/Effect"

import type { Config } from "../config.ts"
import type { DaemonService } from "../droid/daemon-service.ts"
import type { JsonValue } from "../droid/protocol.ts"
import type { RestService } from "../droid/rest-service.ts"
import type { SessionHubService } from "../droid/turns.ts"
import { contextTools } from "./context.ts"
import type { ToolFailure } from "./failure.ts"
import { generatedSurface } from "./generated.ts"
import { annotate, requiresSkill } from "./policy.ts"
import { restTools } from "./rest.ts"
import { Info, infoHandler } from "./server.ts"
import type { Advertised } from "./server.ts"
import { sessionAdminTools } from "./session-admin.ts"
import { sessionDiscoverTools } from "./session-discover.ts"
import { sessionHistoryTools } from "./session-history.ts"
import { sessionMcpTools } from "./session-mcp.ts"
import { sessionPromptTools } from "./session-prompts.ts"
import { sessionTools } from "./session.ts"
import { SkillGate, SkillRead, skillReadHandler } from "./skill.ts"

const gateHandlers = <R>(
  handlers: Readonly<Record<string, (params: never) => Effect.Effect<unknown, ToolFailure, R>>>,
) => {
  const gated: Record<
    string,
    (params: JsonValue | undefined) => Effect.Effect<unknown, ToolFailure, SkillGate | R>
  > = {}

  for (const [name, handler] of Object.entries(handlers)) {
    const requireRead = requiresSkill(name)
      ? SkillGate.use((gate) => gate.requireRead)
      : Effect.void

    gated[name] = (params: JsonValue | undefined) =>
      Effect.flatMap(requireRead, () =>
        // SAFETY: the toolkit decodes each tool's parameters before this wrapper;
        // the merged record erases the individual handler parameter types.
        handler(params as never),
      )
  }

  return gated
}

/**
 * One toolkit holding every operation: the hand-written tools first, then one
 * generated tool per SDK wire method, each annotated with its MCP hints. The
 * full profile advertises it as is; the compact profile dispatches into it.
 * `advertised` is what `server_info` reports, the full list by default.
 */
export const toolsFor = (config: Config, advertised?: Omit<Advertised, "operationCount">) => {
  const generated = generatedSurface(config)
  const session = sessionTools(config)
  const prompts = sessionPromptTools(config)
  const admin = sessionAdminTools(config)
  const mcp = sessionMcpTools()
  const history = sessionHistoryTools()
  const discover = sessionDiscoverTools(config)
  const rest = restTools()
  const context = contextTools()

  const tools: Array<Tool.Any> = [
    Info,
    SkillRead,
    ...session.tools,
    ...prompts.tools,
    ...admin.tools,
    ...mcp.tools,
    ...history.tools,
    ...discover.tools,
    ...rest.tools,
    ...context.tools,
    ...generated.tools,
  ].map(annotate)

  const count = tools.length
  // SAFETY: `Toolkit.make` keys its record by the tool names it is given; the
  // annotation widens that key type so one layer can serve a runtime list.
  const toolkit = Toolkit.make(...tools) as Toolkit.Toolkit<Record<string, Tool.Any>>

  const handlers = gateHandlers<SessionHubService | DaemonService | RestService | SkillGate>({
    server_info: infoHandler(config, {
      profile: advertised?.profile ?? "full",
      toolCount: advertised?.toolCount ?? count,
      operationCount: count,
    }),
    skill_read: skillReadHandler,
    ...session.handlers,
    ...prompts.handlers,
    ...admin.handlers,
    ...mcp.handlers,
    ...history.handlers,
    ...discover.handlers,
    ...rest.handlers,
    ...context.handlers,
    ...generated.handlers,
  })

  // SAFETY: the record covers every tool above; the widened toolkit cannot
  // retain each decoded parameter schema.
  const handlersLayer = toolkit.toLayer(handlers as Parameters<typeof toolkit.toLayer>[0])

  return { toolkit, handlers: handlersLayer, handlerRecord: handlers, tools, count }
}
