import { Effect, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"

import { sessionDiscoverTools } from "../../src/tools/session-discover.ts"
import { sessionTools } from "../../src/tools/session.ts"
import { testConfig } from "../support/config.ts"
import { tempCwd } from "../support/hub.ts"
import { withTools } from "../support/tools.ts"

const WORKTREE = { path: "/fake/worktrees/abc123/repo", branch: "feature/x" }

describe("worktree options on the session tools", () => {
  it("session_create reports the worktree it started in", async () => {
    const created = await Effect.runPromise(
      withTools((harness) =>
        harness.call("session_create", {
          cwd: tempCwd(),
          autonomyLevel: "low",
          worktreeName: "feature/x",
        }),
      ),
    )

    expect(created).toMatchObject({ cwd: tempCwd(), worktree: WORKTREE })
  })

  it("session_list includes the worktree of the session that has one", async () => {
    const listed = await Effect.runPromise(
      withTools((harness) =>
        Effect.gen(function* () {
          yield* harness.call("session_create", {
            cwd: tempCwd(),
            autonomyLevel: "low",
            worktreeName: "feature/x",
          })

          return yield* harness.call("session_list", {})
        }),
      ),
    )

    expect(listed).toMatchObject({ sessions: [{ worktree: WORKTREE }] })
  })

  it("session_run runs one turn in a worktree and reports it", async () => {
    const outcome = await Effect.runPromise(
      withTools((harness) =>
        Effect.gen(function* () {
          return yield* harness.call("session_run", {
            cwd: tempCwd(),
            prompt: "echo:one",
            autonomyLevel: "low",
            worktreeName: "feature/x",
          })
        }),
      ),
    )

    expect(outcome).toMatchObject({
      status: "completed",
      result: { structuredOutput: { echo: "one" } },
      worktree: WORKTREE,
    })
  })

  it("session_run leaves the worktree out of the result when none was requested", async () => {
    const outcome = await Effect.runPromise(
      withTools((harness) =>
        harness.call("session_run", { cwd: tempCwd(), prompt: "echo:one", autonomyLevel: "low" }),
      ),
    )

    expect(outcome).not.toHaveProperty("worktree")
  })

  it("session_create refuses a branch name that could be read as a flag", async () => {
    const failure = await Effect.runPromise(
      withTools((harness) =>
        harness
          .call("session_create", {
            cwd: tempCwd(),
            autonomyLevel: "low",
            worktreeName: "--auto",
          })
          .pipe(Effect.flip),
      ),
    )

    expect(failure.code).toBe("invalid_worktree")
  })

  it("advertises worktree and worktreeName on both tools that start a session", () => {
    const config = testConfig()

    const tools = [...sessionTools(config).tools, ...sessionDiscoverTools(config).tools]

    for (const name of ["session_create", "session_run"]) {
      const tool = tools.find((entry) => entry.name === name)

      if (tool === undefined) throw new Error("missing " + name)

      // SAFETY: Tool.Any erases each parameter schema to Schema.Top. These tools
      // are Struct schemas with no decoding services.
      const parameters = tool.parametersSchema as Schema.Codec<unknown>

      const base = { cwd: "/tmp", autonomyLevel: "low", prompt: "p" }

      const accepts = (extra: Record<string, Schema.Json>): boolean =>
        Option.isSome(Schema.decodeUnknownOption(parameters)({ ...base, ...extra }))

      expect(accepts({}), name).toBe(true)
      expect(accepts({ worktree: true }), name).toBe(true)
      expect(accepts({ worktreeName: "feature/x" }), name).toBe(true)
      expect(accepts({ worktree: "yes" }), name).toBe(false)
      expect(accepts({ worktreeName: 1 }), name).toBe(false)
    }
  })
})
