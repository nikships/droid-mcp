import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { parseWorktree, worktreeFlags } from "../../src/droid/turns.ts"
import type { CreateSessionOptions } from "../../src/droid/turns.ts"
import { fakeHub, tempCwd } from "../support/hub.ts"
import type { FakeHubOptions } from "../support/hub.ts"

const create = (extra: Partial<CreateSessionOptions>, hubOptions: FakeHubOptions = {}) =>
  Effect.scoped(
    Effect.acquireRelease(fakeHub(hubOptions), (hub) => hub.closeAll).pipe(
      Effect.flatMap((hub) =>
        Effect.gen(function* () {
          const created = yield* hub.api.create({
            cwd: tempCwd(),
            autonomyLevel: "low",
            ...extra,
          })

          const listed = yield* hub.api.sessions

          return { created, listed }
        }),
      ),
    ),
  )

const ask = (extra: Partial<CreateSessionOptions>, prompt: string) =>
  Effect.scoped(
    Effect.acquireRelease(fakeHub(), (hub) => hub.closeAll).pipe(
      Effect.flatMap((hub) =>
        Effect.gen(function* () {
          const created = yield* hub.api.create({ cwd: tempCwd(), autonomyLevel: "low", ...extra })

          return yield* hub.api.stream({ sessionId: created.sessionId, prompt })
        }),
      ),
    ),
  )

describe("session worktrees", () => {
  it("reports the worktree a named branch got and keeps cwd as requested", async () => {
    const { created, listed } = await Effect.runPromise(create({ worktreeName: "feature/x" }))

    expect(created.cwd).toBe(tempCwd())
    expect(created.worktree).toEqual({
      path: "/fake/worktrees/abc123/repo",
      branch: "feature/x",
    })
    expect(listed).toHaveLength(1)
    expect(listed[0]?.worktree).toEqual(created.worktree)
  })

  it("lets the CLI pick the branch when only worktree is set", async () => {
    const { created } = await Effect.runPromise(create({ worktree: true }))

    expect(created.worktree).toEqual({
      path: "/fake/worktrees/abc123/repo",
      branch: "fake-branch",
    })
  })

  it("starts no worktree unless asked", async () => {
    const plain = await Effect.runPromise(create({}))
    const off = await Effect.runPromise(create({ worktree: false }))

    expect("worktree" in plain.created).toBe(false)
    expect("worktree" in plain.listed[0]!).toBe(false)
    expect("worktree" in off.created).toBe(false)
  })

  it("initializes the session inside the worktree, not the directory it was requested from", async () => {
    const inWorktree = await Effect.runPromise(ask({ worktreeName: "feature/x" }, "cwd"))
    const plain = await Effect.runPromise(ask({}, "cwd"))

    expect(inWorktree.result?.structuredOutput).toEqual({ cwd: "/fake/worktrees/abc123/repo" })
    expect(plain.result?.structuredOutput).toEqual({ cwd: tempCwd() })
  })

  it("fails when the CLI never creates the worktree", async () => {
    const failure = await Effect.runPromise(
      create(
        { worktree: true },
        { env: { FAKE_DROID_WORKTREE: "silent" }, requestTimeoutMs: 300 },
      ).pipe(Effect.flip),
    )

    expect(failure.code).toBe("exec_timeout")
    expect(failure.message).toContain("worktree")
  })

  it("waits for the whole announcement line before trusting it", async () => {
    const { created } = await Effect.runPromise(
      create({ worktreeName: "feature(x)y" }, { env: { FAKE_DROID_WORKTREE: "split" } }),
    )

    expect(created.worktree).toEqual({
      path: "/fake/worktrees/abc123/repo",
      branch: "feature(x)y",
    })
  })

  it("still finds the announcement after more stderr than the client keeps", async () => {
    const { created } = await Effect.runPromise(
      create({ worktreeName: "feature/x" }, { env: { FAKE_DROID_WORKTREE: "noisy" } }),
    )

    expect(created.worktree).toEqual({ path: "/fake/worktrees/abc123/repo", branch: "feature/x" })
  })

  it("reports why the CLI refused to start", async () => {
    const failure = await Effect.runPromise(
      create({ worktree: true }, { env: { FAKE_DROID_WORKTREE: "reject" } }).pipe(Effect.flip),
    )

    expect(failure.code).toBe("exec_failed")
    expect(failure.message).toContain("Not inside a git repository")
  })

  it("passes branch names git allows through to the CLI", async () => {
    for (const worktreeName of ["_prefix", "feature+c", "feat@work", "équipe"]) {
      const { created } = await Effect.runPromise(create({ worktreeName }))

      expect(created.worktree?.branch, worktreeName).toBe(worktreeName)
    }
  })

  it("rejects a branch name that is blank or could read as a flag", async () => {
    for (const worktreeName of ["--x", "-b", "", "   ", "a\0b"]) {
      const failure = await Effect.runPromise(create({ worktreeName }).pipe(Effect.flip))

      expect(failure.code, worktreeName).toBe("invalid_worktree")
    }
  })

  it("rejects a branch name with worktree set to false", async () => {
    const failure = await Effect.runPromise(
      create({ worktree: false, worktreeName: "x" }).pipe(Effect.flip),
    )

    expect(failure.code).toBe("invalid_worktree")
  })
})

describe("worktree flags", () => {
  it("joins the name to the flag so it cannot become another one", async () => {
    expect(await Effect.runPromise(worktreeFlags({}))).toEqual([])
    expect(await Effect.runPromise(worktreeFlags({ worktree: false }))).toEqual([])
    expect(await Effect.runPromise(worktreeFlags({ worktree: true }))).toEqual(["--worktree"])
    expect(await Effect.runPromise(worktreeFlags({ worktreeName: "a/b-1.2" }))).toEqual([
      "--worktree=a/b-1.2",
    ])
    expect(await Effect.runPromise(worktreeFlags({ worktree: true, worktreeName: "x" }))).toEqual([
      "--worktree=x",
    ])
  })

  it("reads the CLI's announcement and nothing else", () => {
    expect(
      parseWorktree("Created worktree at /Users/a b/.factory/worktrees/1/repo (branch: feat/x)\n"),
    ).toEqual({ path: "/Users/a b/.factory/worktrees/1/repo", branch: "feat/x" })
    expect(parseWorktree("warning\nCreated worktree at /w (branch: b)\nmore\n")).toEqual({
      path: "/w",
      branch: "b",
    })
    expect(parseWorktree("Created worktree at /w (branch: feature(x)")).toBeUndefined()
    expect(parseWorktree("Created worktree at /w (branch: feature(x)y)\n")).toEqual({
      path: "/w",
      branch: "feature(x)y",
    })
    expect(parseWorktree("")).toBeUndefined()
    expect(parseWorktree("Worktree directory removed. Branch preserved.\n")).toBeUndefined()
  })
})
