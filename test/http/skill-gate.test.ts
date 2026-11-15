import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { LoadSessionResultSchema } from "@factory/droid-sdk"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as Schema from "effect/Schema"
import { afterEach, describe, expect, it } from "vitest"

import { SKILL_MD, SKILL_URI } from "../../src/generated/skill.ts"
import { makeSkillGate } from "../../src/tools/skill.ts"
import type { SkillGateApi } from "../../src/tools/skill.ts"
import { testConfig } from "../support/config.ts"
import { startFakeDaemon } from "../support/fake-daemon.ts"
import type { FakeDaemon, ScriptedReply } from "../support/fake-daemon.ts"
import { startFakeFactoryApi } from "../support/fake-factory-api.ts"
import type { FakeFactoryApi } from "../support/fake-factory-api.ts"
import { expectBody, initialize, readBody, startServer } from "../support/mcp-http.ts"
import type { Json, TestServer } from "../support/mcp-http.ts"
import { connect } from "../support/mcp-tools.ts"
import type { ToolClient } from "../support/mcp-tools.ts"

const KEY = "skill-gate-key"
const PROTOCOL = "2025-11-25"

const LOAD_SESSION_RESULT = {
  session: { messages: [] },
  settings: { modelId: "fake-model", reasoningEffort: "low" },
}

const FailureBody = Schema.Struct({
  result: Schema.Struct({
    isError: Schema.Literal(true),
    content: Schema.Array(Schema.Struct({ text: Schema.String })),
  }),
})

const failureOf = (body: Json | undefined): { code: string; message: string } => {
  const parsed = expectBody(FailureBody, body)
  const text = parsed.result.content[0]?.text ?? ""

  return Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ code: Schema.String, message: Schema.String })),
  )(text)
}

const OkBody = Schema.Struct({
  result: Schema.Struct({
    isError: Schema.optional(Schema.Literal(false)),
    structuredContent: Schema.Unknown,
  }),
})

const servers: Array<TestServer> = []
const clients: Array<ToolClient> = []
const daemons: Array<FakeDaemon> = []
const apis: Array<FakeFactoryApi> = []
const directories: Array<string> = []

afterEach(async () => {
  while (clients.length > 0) await clients.pop()?.dispose()

  while (servers.length > 0) await servers.pop()?.dispose()

  while (daemons.length > 0) await daemons.pop()?.close()

  while (apis.length > 0) await apis.pop()?.close()

  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
  directories.length = 0
})

const openSession = async (server: TestServer) => {
  const { sessionId } = await initialize(server, PROTOCOL, { authorization: "Bearer " + KEY })

  const headers = {
    authorization: "Bearer " + KEY,
    "mcp-session-id": sessionId ?? "",
    "mcp-protocol-version": PROTOCOL,
  }

  let nextId = 1

  const rpc = async (method: string, params: Json = {}) => {
    nextId += 1

    return await readBody(
      await server.post({ jsonrpc: "2.0", id: nextId, method, params }, headers),
    )
  }

  return {
    rpc,
    call: (name: string, args: Json = {}) => rpc("tools/call", { name, arguments: args }),
    readResource: (uri: string) => rpc("resources/read", { uri }),
    getPrompt: (name: string) => rpc("prompts/get", { name }),
  }
}

const sessionlessRpc = (server: TestServer) => {
  let id = 0

  return async (key: string, method: string, target: string, params: Record<string, Json>) => {
    id += 1

    return readBody(
      await server.post(
        {
          jsonrpc: "2.0",
          id,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": { name: "vitest", version: "1.0.0" },
            },
          },
        },
        {
          authorization: "Bearer " + key,
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": method,
          "mcp-name": target,
        },
      ),
    )
  }
}

const ROUTES = [
  { toolProfile: "full", via: "direct" },
  { toolProfile: "compact", via: "dispatch" },
  { toolProfile: "compact", via: "batch" },
] as const

const LOCAL_ROUTES = [...ROUTES, { toolProfile: "compact", via: "direct" }] as const

const Failure = Schema.Struct({ code: Schema.String, message: Schema.String })

const BatchBody = Schema.Struct({
  steps: Schema.Array(
    Schema.Struct({
      status: Schema.Literals(["ok", "failed", "skipped"]),
      result: Schema.optional(Schema.Unknown),
      error: Schema.optional(Failure),
    }),
  ),
})

type Outcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly failure: typeof Failure.Type }

const callVia = async (
  session: Awaited<ReturnType<typeof openSession>>,
  via: (typeof LOCAL_ROUTES)[number]["via"],
  name: string,
  args: Json = {},
): Promise<Outcome> => {
  if (via === "batch") {
    const body = expectBody(
      OkBody,
      await session.call("batch", { steps: [{ name, arguments: args }] }),
    )

    const step = Schema.decodeUnknownSync(BatchBody)(body.result.structuredContent).steps[0]

    return step?.status === "ok"
      ? { ok: true, value: step.result }
      : { ok: false, failure: Schema.decodeUnknownSync(Failure)(step?.error) }
  }

  const body =
    via === "direct"
      ? await session.call(name, args)
      : await session.call("tool_call", { name, arguments: args })

  if (Schema.is(FailureBody)(body)) return { ok: false, failure: failureOf(body) }

  const value = expectBody(OkBody, body).result.structuredContent

  return {
    ok: true,
    value:
      via === "direct"
        ? value
        : Schema.decodeUnknownSync(Schema.Struct({ result: Schema.optional(Schema.Unknown) }))(
            value,
          ).result,
  }
}

describe.each(LOCAL_ROUTES)("local gate: $toolProfile $via", ({ toolProfile, via }) => {
  it("gates valid stream inputs before the read and reaches the hub after it", async () => {
    const server = await startServer({ config: testConfig({ toolProfile }), keys: [KEY] })
    servers.push(server)
    const session = await openSession(server)
    const args = { sessionId: "nope", prompt: "x" }

    expect(await callVia(session, via, "session_stream", args)).toMatchObject({
      ok: false,
      failure: { code: "skill_not_read" },
    })

    // Local reads and controls retain their existing session_* gate.
    for (const [name, args] of [
      ["session_list", {}],
      ["session_interrupt", { sessionId: "nope" }],
      ["session_close", { sessionId: "nope" }],
    ] as const) {
      expect(await callVia(session, via, name, args)).toMatchObject({
        ok: false,
        failure: { code: "skill_not_read" },
      })
    }

    await session.call("skill_read")

    expect(await callVia(session, via, "session_stream", args)).toEqual({
      ok: false,
      failure: { code: "session_not_found", message: "no session nope; call session_create first" },
    })
  })

  it("validates stream arguments before checking the gate", async () => {
    const server = await startServer({ config: testConfig({ toolProfile }), keys: [KEY] })
    servers.push(server)
    const session = await openSession(server)

    if (via === "direct") {
      const body = await session.call("session_stream", { sessionId: "nope" })
      expect(JSON.stringify(body)).toMatch(/Invalid parameters|Invalid tool parameters/)
      expect(JSON.stringify(body)).not.toContain("skill_not_read")
    } else {
      expect(await callVia(session, via, "session_stream", { sessionId: "nope" })).toMatchObject({
        ok: false,
        failure: { code: "invalid_arguments" },
      })
    }
  })

  it("reaches the local hub without a read when the gate is disabled", async () => {
    const server = await startServer({
      config: testConfig({ toolProfile, requireSkill: false }),
      keys: [KEY],
    })

    servers.push(server)
    const session = await openSession(server)

    expect(
      await callVia(session, via, "session_stream", { sessionId: "nope", prompt: "x" }),
    ).toMatchObject({ ok: false, failure: { code: "session_not_found" } })
  })
})

describe.each(["full", "compact"] as const)("root skill reads: %s", (toolProfile) => {
  describe.each(["stateful", "sessionless"] as const)("%s identity", (identity) => {
    it.each([
      [
        "skills/get",
        "skill://droid/references/prompts.md",
        { uri: "skill://droid/references/prompts.md" },
      ],
      ["prompts/get", "other", { name: "other" }],
    ] as const)("does not unlock after non-root %s", async (method, target, params) => {
      const server = await startServer({ config: testConfig({ toolProfile }), keys: [KEY] })
      servers.push(server)
      const rpcSessionless = sessionlessRpc(server)

      const rpc =
        identity === "stateful"
          ? (await openSession(server)).rpc
          : (method: string, params: Record<string, Json>) =>
              rpcSessionless(KEY, method, method === "tools/call" ? "session_list" : target, params)

      const list = () => rpc("tools/call", { name: "session_list", arguments: {} })

      expect(failureOf(await list()).code).toBe("skill_not_read")
      expect(await rpc(method, params)).toMatchObject({ error: { code: expect.any(Number) } })
      expect(failureOf(await list()).code).toBe("skill_not_read")
    })
  })

  it("does not unlock a stateful session after a reference-only read", async () => {
    const server = await startServer({ config: testConfig({ toolProfile }), keys: [KEY] })
    servers.push(server)
    const session = await openSession(server)
    const body = await session.readResource("skill://droid/references/prompts.md")

    expect(body).toMatchObject({
      result: { contents: [{ text: expect.stringContaining("proceed_edit") }] },
    })
    expect(failureOf(await session.call("session_list")).code).toBe("skill_not_read")
  })

  it.each([
    ["tools/call", "skill_read", { name: "skill_read", arguments: {} }],
    ["resources/read", SKILL_URI, { uri: SKILL_URI }],
    ["skills/get", SKILL_URI, { uri: SKILL_URI }],
    ["prompts/get", "droid", { name: "droid" }],
  ] as const)(
    "unlocks sessionless calls via %s and isolates bearer keys",
    async (method, target, params) => {
      const server = await startServer({
        config: testConfig({ toolProfile }),
        keys: [KEY, "other-skill-key"],
      })

      servers.push(server)
      const rpc = sessionlessRpc(server)

      const list = (key = KEY) =>
        rpc(key, "tools/call", "session_list", { name: "session_list", arguments: {} })

      expect(failureOf(await list()).code).toBe("skill_not_read")
      await rpc(KEY, "resources/read", "skill://droid/references/prompts.md", {
        uri: "skill://droid/references/prompts.md",
      })
      expect(failureOf(await list()).code).toBe("skill_not_read")

      const read = await rpc(KEY, method, target, params)
      expect(read).toHaveProperty("result")
      expect(read).not.toHaveProperty("error")
      expect(expectBody(OkBody, await list()).result.structuredContent).toEqual({ sessions: [] })
      // A new sessionless request shares the same bearer-key read state.
      expect(expectBody(OkBody, await list()).result.structuredContent).toEqual({ sessions: [] })
      expect(failureOf(await list("other-skill-key")).code).toBe("skill_not_read")
    },
  )
})

describe.each(ROUTES)("work-start gate: $toolProfile $via", ({ toolProfile, via }) => {
  const openBackends = async (requireSkill = true) => {
    const directory = mkdtempSync(join(tmpdir(), "droid-mcp-skill-gate-"))
    directories.push(directory)

    const daemon = await startFakeDaemon(join(directory, "daemon.sock"), {
      onRequest: (request): ScriptedReply => {
        if (request.method === "daemon.authenticate") {
          return { result: { userId: "user-1", orgId: "org-1" } }
        }

        if (request.method === "daemon.run_automation") {
          return {
            result: { prompt: "x", automationName: "test", automationId: "a-1", cwd: directory },
          }
        }

        if (request.method === "daemon.list_automations") return { result: { automations: [] } }

        if (request.method === "daemon.fork_session" || request.method === "droid.fork_session") {
          return { result: { newSessionId: "s-fork" } }
        }

        if (request.method === "daemon.dispatch_automation_run") {
          return { result: { success: true, sessionId: "s-automation" } }
        }

        if (request.method === "droid.load_session") return { result: LOAD_SESSION_RESULT }

        return { result: {} }
      },
    })

    daemons.push(daemon)
    const api = await startFakeFactoryApi()
    apis.push(api)

    const server = await startServer({
      config: testConfig({
        toolProfile,
        requireSkill,
        socketPath: daemon.socketPath,
        runtimeDir: directory,
        factoryApiKey: "fake-factory-key",
        factoryBaseUrl: api.baseUrl,
      }),
      keys: [KEY],
    })

    servers.push(server)

    return { daemon, api, server, session: await openSession(server), directory }
  }

  it.each([true, false])(
    "blocks backend I/O until a root read only when required (%s)",
    async (requireSkill) => {
      const { daemon, api, session, directory } = await openBackends(requireSkill)

      const calls: ReadonlyArray<{ name: string; args: Json; method?: string; path?: string }> = [
        {
          name: "daemon_initialize_session",
          args: {
            machineId: "m-1",
            cwd: directory,
            token: "fake-session-token",
            autonomyLevel: "low",
            autonomyMode: "normal",
          },
          method: "daemon.initialize_session",
        },
        {
          name: "daemon_add_user_message",
          args: { sessionId: "s-1", text: "x" },
          method: "daemon.add_user_message",
        },
        {
          name: "daemon_run_automation",
          args: { automationId: "a-1" },
          method: "daemon.run_automation",
        },
        {
          name: "daemon_load_session",
          args: { sessionId: "s-1", token: "fake" },
          method: "daemon.load_session",
        },
        {
          name: "daemon_fork_session",
          args: { sessionId: "s-1" },
          method: "daemon.fork_session",
        },
        {
          name: "daemon_resolve_queued_user_message",
          args: {},
          method: "daemon.resolve_queued_user_message",
        },
        {
          name: "droid_load_session",
          args: { sessionId: "s-1" },
          method: "droid.load_session",
        },
        {
          name: "droid_fork_session",
          args: {},
          method: "droid.fork_session",
        },
        {
          name: "droid_resolve_queued_user_message",
          args: { requestId: "r-1", action: "update_queue", queuePlacement: "end_of_turn" },
          method: "droid.resolve_queued_user_message",
        },
        {
          name: "daemon_dispatch_automation_run",
          args: { automationId: "a-1" },
          method: "daemon.dispatch_automation_run",
        },
        {
          name: "rest_create_remote_session",
          args: { body: { computerId: "c-1" } },
          path: "/api/v0/sessions",
        },
        {
          name: "rest_post_remote_session_message",
          args: { sessionId: "s-1", body: { text: "x" } },
          path: "/api/v0/sessions/s-1/messages",
        },
      ]

      if (requireSkill) {
        for (const { name, args } of calls) {
          expect(await callVia(session, via, name, args), name).toMatchObject({
            ok: false,
            failure: { code: "skill_not_read" },
          })
          expect(daemon.requests, name).toHaveLength(0)
          expect(api.requests, name).toHaveLength(0)
        }

        await session.call("skill_read")
      }

      for (const call of calls) {
        const beforeDaemon = daemon.requests.length
        const beforeApi = api.requests.length

        expect(await callVia(session, via, call.name, call.args), call.name).toMatchObject({
          ok: true,
        })

        if (call.method !== undefined) {
          expect(daemon.requests.slice(beforeDaemon).map((request) => request.method)).toContain(
            call.method,
          )
          expect(api.requests).toHaveLength(beforeApi)
        } else {
          expect(api.requests.slice(beforeApi)).toMatchObject([{ method: "POST", path: call.path }])
          expect(daemon.requests).toHaveLength(beforeDaemon)
        }
      }
    },
  )

  it("leaves daemon and hosted reads and controls open without unlocking work", async () => {
    const { daemon, api, session } = await openBackends()

    const calls = [
      ["daemon_list_automations", {}],
      ["daemon_interrupt_session", { sessionId: "s-1" }],
      ["rest_get_remote_session", { sessionId: "s-1" }],
      ["rest_interrupt_remote_session", { sessionId: "s-1" }],
    ] as const

    for (const [name, args] of calls) {
      expect(await callVia(session, via, name, args), name).toMatchObject({ ok: true })
    }

    expect(daemon.requests.map((request) => request.method)).toEqual([
      "daemon.authenticate",
      "daemon.list_automations",
      "daemon.interrupt_session",
    ])
    expect(api.requests).toMatchObject([
      { method: "GET", path: "/api/v0/sessions/s-1" },
      { method: "POST", path: "/api/v0/sessions/s-1/interrupt" },
    ])
    expect(
      await callVia(session, via, "daemon_add_user_message", { sessionId: "s-1", text: "x" }),
    ).toMatchObject({ ok: false, failure: { code: "skill_not_read" } })
    expect(daemon.requests).toHaveLength(3)
  })

  it("isolates work-start reads between MCP sessions", async () => {
    const { daemon, api, server, session } = await openBackends()
    const second = await openSession(server)
    await session.call("skill_read")
    const args = { sessionId: "s-1", text: "x" }

    expect(await callVia(session, via, "daemon_add_user_message", args)).toMatchObject({
      ok: true,
    })
    const before = daemon.requests.length

    expect(await callVia(second, via, "daemon_add_user_message", args)).toMatchObject({
      ok: false,
      failure: { code: "skill_not_read" },
    })
    expect(
      await callVia(second, via, "rest_create_remote_session", { body: { computerId: "c-1" } }),
    ).toMatchObject({ ok: false, failure: { code: "skill_not_read" } })
    expect(daemon.requests).toHaveLength(before)
    expect(api.requests).toHaveLength(0)
  })
})

describe("skill-read gating", () => {
  it("uses an SDK-valid load-session reply", () => {
    expect(LoadSessionResultSchema.safeParse(LOAD_SESSION_RESULT).success).toBe(true)
  })

  it("blocks session_* tools before skill_read and unlocks after skill_read", async () => {
    const server = await startServer({
      config: testConfig({ toolProfile: "compact" }),
      keys: [KEY],
    })

    servers.push(server)

    const session = await openSession(server)

    const gatedDirect = failureOf(await session.call("session_list"))

    expect(gatedDirect.code).toBe("skill_not_read")

    const gatedToolCall = failureOf(
      await session.call("tool_call", { name: "session_list", arguments: {} }),
    )

    expect(gatedToolCall.code).toBe("skill_not_read")

    const gatedBatch = expectBody(
      OkBody,
      await session.call("batch", { steps: [{ name: "session_list" }] }),
    )

    expect(gatedBatch.result.structuredContent).toMatchObject({
      failed: 1,
      steps: [{ name: "session_list", status: "failed", error: { code: "skill_not_read" } }],
    })

    // Ungated tools stay available before reading the skill.
    const info = expectBody(OkBody, await session.call("server_info"))

    expect(info.result.structuredContent).toMatchObject({ profile: "compact" })

    const skill = expectBody(OkBody, await session.call("skill_read"))

    expect(skill.result.structuredContent).toEqual({ uri: SKILL_URI, markdown: SKILL_MD })

    const unlocked = expectBody(OkBody, await session.call("session_list"))

    expect(unlocked.result.structuredContent).toEqual({ sessions: [] })
  })

  it("unlocks session_* tools when reading the skill resource", async () => {
    const server = await startServer({ config: testConfig(), keys: [KEY] })
    servers.push(server)

    const session = await openSession(server)

    expect(failureOf(await session.call("session_list")).code).toBe("skill_not_read")

    await session.readResource(SKILL_URI)

    expect(expectBody(OkBody, await session.call("session_list")).result.structuredContent).toEqual(
      {
        sessions: [],
      },
    )
  })

  it("unlocks session_* tools when getting the droid prompt", async () => {
    const server = await startServer({ config: testConfig(), keys: [KEY] })
    servers.push(server)

    const session = await openSession(server)

    expect(failureOf(await session.call("session_list")).code).toBe("skill_not_read")

    await session.getPrompt("droid")

    expect(expectBody(OkBody, await session.call("session_list")).result.structuredContent).toEqual(
      {
        sessions: [],
      },
    )
  })

  it("tracks skill-read state per MCP session", async () => {
    const server = await startServer({ config: testConfig(), keys: [KEY] })
    servers.push(server)

    const first = await openSession(server)
    const second = await openSession(server)

    await first.call("skill_read")

    expect(expectBody(OkBody, await first.call("session_list")).result.structuredContent).toEqual({
      sessions: [],
    })
    expect(failureOf(await second.call("session_list")).code).toBe("skill_not_read")
  })

  it("allows session_* tools immediately when requireSkill is false", async () => {
    const client = await connect({
      config: testConfig({ requireSkill: false }),
      readSkill: false,
    })

    clients.push(client)

    expect(await client.ok("session_list")).toEqual({ sessions: [] })
  })
})

describe("skill gate read set", () => {
  const requireFor = (gate: SkillGateApi, sessionId: string) =>
    Effect.runPromiseExit(
      gate.requireRead.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request("http://localhost/mcp", { headers: { "mcp-session-id": sessionId } }),
          ),
        ),
      ),
    )

  it("drops the least recently used session past its limit", async () => {
    const gate = makeSkillGate(true, 2)

    await Effect.runPromise(gate.markSessionRead("a"))
    await Effect.runPromise(gate.markSessionRead("b"))

    // Using "a" makes "b" the oldest key.
    expect(Exit.isSuccess(await requireFor(gate, "a"))).toBe(true)

    await Effect.runPromise(gate.markSessionRead("c"))

    expect(Exit.isSuccess(await requireFor(gate, "a"))).toBe(true)
    expect(Exit.isSuccess(await requireFor(gate, "b"))).toBe(false)
    expect(Exit.isSuccess(await requireFor(gate, "c"))).toBe(true)
  })
})
