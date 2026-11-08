# Harness v2: When does scaffolding become a burden?

Status: **design, 2026-11-08.** Nothing in this document has been run on a
model. Sections are labelled **[measured]** (evidence in this repository),
**[derived]** (follows from code or arithmetic, checked offline) or
**[hypothesis]** (to be tested). The frozen v1 protocol and its results are
not changed by this document.

## 1. Motivation from v1

Campaign `main-2026-10-30-v1` (ADR 0011, `docs/research/FOUR_MODEL_COMPARISON.md`)
ran four models through one agent harness, upstage-cli `802cddd`, under one
envelope (30 turns, 60 tool calls, 2,700 s). **[measured]**

| | Kanana 2 | EXAONE 4.5 | A.X 4.0 | Solar Open 2 (NVFP4, 8K) |
|---|---|---|---|---|
| BFCL subset (n=1106) | 888 (80.3%) | 881 (79.7%) | 681 (61.6%) | 898 (81.2%) |
| SWE-bench Verified stage 1 (n=50) | 0 | 1 | 1 | 4 |
| Dominant SWE stop reason | output truncated 37/50 | turn budget 46/50 | completed 33/50 | budget 41/50 |
| Empty patches | 33 | 49 | 31 | 44 |
| Input budget per request (tokens) | 7,372 | 7,372 | 7,372 | 3,686 |
| Recoverable tool-error rate | 22.4% | 1.6% | 14.2% | 3.9% |

Three models that are indistinguishable on BFCL function calling resolve 0–4
of 50 SWE-bench instances. No SWE-bench difference between models is
statistically supported. Each model fails in a *different* way that involves
the envelope or the scaffold: Kanana's reasoning fills the 8,192-token output
cap, EXAONE explores until the turn budget runs out, and Solar works under constant
compaction. A.X's BFCL deficit is confined to parallel calls (1/240 vs 680/866
elsewhere). That is a model/serving-interface behaviour, not a property of the
coding harness. **[measured]** None of this shows that a specific harness
feature caused a failure. v1 changed no harness factor.

The v1 input budget is arithmetic, not a measurement: 16,384 − 8,192 output
reservation − 5% safety margin (819) = 7,372 tokens per request for the 16K
models, and 8,192 − 4,096 − 410 = 3,686 for Solar. The system prompt, tool
schemas, automatic repository context and the conversation all share this
budget. **[derived]**

## 2. Research question

**When does scaffolding become a burden?** How do agent-harness architecture,
tool interface, context-management policy and inference budget interact to
determine coding-agent outcomes for open, locally served models?

The project needs to separate five sources of outcome differences:

1. model capability;
2. model/serving compatibility (chat template, tool-call parser, reasoning parser);
3. harness structure and interface;
4. context and output budget;
5. infrastructure constraints (contended GPUs, Docker storage, wall-clock).

Working premise, not a claim: scaffolding is not uniformly good or bad.
Whether extra scaffolding helps depends on the model's tool-use behaviour,
its reasoning length and the budget left for the task.

## 3. Known architecture concerns (checked offline, 2026-11-08)

### A. Retrieval query contamination [derived; tested]

upstage-cli's `context-builder.mjs` (at `802cddd`) takes the **first eight
unique tokens of at least 3 characters from the whole input** as retrieval
keywords. These feed `find_symbol`, `search_code`, `glob` and
`find_references`, which choose up to 5 files, plus a semantic retrieval query.
The SWE-bench wrapper (`kab-swebench-prompt-v1`) puts the issue after one
sentence with exactly eight qualifying tokens. So for **every** v1 SWE-bench
request, the keywords were
`you, are, working, checkout, the, <owner/repo>, repository, commit`, and no
issue term was ever used. This follows from the template and the code. It is
pinned by `harness/tests/h32-agent-harness.test.mjs`. Run records do not store
the keywords, so it could not be read back from the v1 records.

A second interaction makes this narrower still. Under the v1 SWE-bench tool
allowlist (`read_file write_file edit_file list_files search_code glob
run_shell`), the task policy removes `repo_map`, `find_symbol`,
`find_references` and `list_modules`. buildContext's internal calls to them
fail quietly, so there is no repository map, and files are chosen only by
`search_code`/`glob` on the wrapper words. With that allowlist, in a synthetic
repository (eight distractor files and one file named by the issue), the
wrapped prompt retrieved distractors and missed the target. The issue text
alone retrieved the target (h32).

What this does *not* show: that the wrong keywords lowered v1 resolve rates.
The block was capped (`repoContextMaxChars`), models could still search
themselves, and correct retrieval would also consume budget. It is a
candidate factor (§5, F2).

### B. Shell expressiveness [derived; tested]

In Docker tasks, KAB replaces upstage-cli's `run_shell` with a wrapper
(`harness/src/agent/sandboxed-tools.mjs`). The wrapper splits the command on
whitespace with no quote handling, refuses `; & | \`` and `$(`, and starts a
fresh `docker run` for each call (h32):

| Command | What reaches the container |
|---|---|
| `grep -rn "def foo" src` | `grep -rn '"def' 'foo"' src`: a *silently different* search |
| `pytest t.py -k "not slow"` | broken argument split |
| `python setup.py test > out.txt` | `>` passed as an argument, so there is no redirect |
| `grep … \| head`, `cd src && pytest`, `python -c "a; b"` | refused |

The security boundary is the container: hardened flags, `--network none`, a
workspace-only mount, a PID limit, realpath-confined file tools, escaping-symlink
removal and a lock between commands and file tools. The metacharacter filter
is not part of that boundary. An agent can already write a script with
`write_file` and run `bash script.sh` inside the same container. A
`sh -c`-in-the-same-container tool interface (as `DockerSandbox.execShell`
already does for checks) would therefore change expressiveness, not
isolation. That conclusion still needs its own security review before any
experiment uses it. **No sandbox protection is removed in this phase.**

mini-SWE-agent's interface is the opposite extreme: a single bash tool, and
each action is an independent subprocess (`LocalEnvironment.execute`).

### C. Continuation and termination [derived]

| Behaviour | Where it lives |
|---|---|
| Stop on `finish_reason=length` (no continuation, no retry; the cut-off tool call is not executed) | upstage-cli loop |
| Output cap value (8,192 / 4,096) | KAB `local-models.mjs` (sent as `max_tokens`) |
| Turn, tool-call and wall-clock budgets | KAB task envelope → upstage-cli loop budget |
| Tool-loop detection (same call signature ≥ threshold in the last 20; at most 2 replans) and test-failure critic (3 cycles) | upstage-cli loop (module constants, not configurable) |
| Compaction (proactive, then 4 → 2 → 0 recent messages; one retry after a server "too long") | upstage-cli loop + ContextManager |
| Partial patch at termination | KAB runner: the workspace diff is captured **whatever the stop reason**. An empty patch means no file changed. |
| Resolution | official evaluator only |

Wall-clock budgets on a shared GPU are confounded by contention: the same
episode can stop at a different point on a busier day. Turn and tool-call
budgets should bind before wall-clock does in v2.

### D. Harness/evaluator coupling [derived]

The runner (`TaskRunner.run(task, adapter)`) is already agent-agnostic: task
identity, base commit, Docker isolation, patch capture, trusted paths,
official scoring and failure accounting do not depend on the adapter. The
coupling is in the **task spec**. `benchmarks/swebench.mjs` writes upstage-cli
tool names (`read_file`, `run_shell`, …) and the turn envelope into
`task.agent`. For v2 these move into the agent-harness descriptor. The
SWE-bench task should keep only instance, base commit, image, prompt and
sandbox.

## 4. Literature and public baselines

Citations are given for orientation and must be checked against the
publications before any external write-up.

- **SWE-agent** (Yang et al., 2024): the agent-computer interface (tool design,
  feedback format) changes outcomes for the same model. MIT. Its README now
  says mini-SWE-agent has superseded it.
- **mini-SWE-agent** (SWE-agent team): bash-only, independent subprocess per
  action, litellm model access (`hosted_vllm/…` + `api_base` for a local
  vLLM), `mini-extra swebench` runner on the official instance images. MIT,
  Python ≥ 3.10. It stops when an action's first output line is
  `COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT`. Repeated format errors end the run.
  The release version is not yet verified; pin it at integration.
- **OpenHands** (Wang et al., 2024) / OpenHands software-agent SDK: an
  event-stream agent with a richer tool set and a workspace server. MIT per
  its README. Packaging, version and SWE-bench runner location are not yet
  verified.
- **Agentless** (Xia et al., 2024): a fixed localize-repair-validate pipeline
  without an agent loop. It is a reference point for "less scaffolding".
- **Long-context degradation** (e.g. Liu et al., "Lost in the Middle"): more
  context is not monotonically better.
- **upstage-cli** (this project's v1 harness): a structured tool registry (7
  tools advertised under the v1 SWE-bench allowlist, 21 Docker-safe in all),
  automatic repository context on every step, compaction, replanning and a
  critic.

Vendor-published SWE-bench scores are not attributed to any open-source
harness unless that provenance is documented.

## 5. Design

### Complexity is measured, not asserted

A harness is not "light" or "heavy" because of its source size. Per episode,
from the trace and server-counted tokens:

| Dimension | Metric | Available now? |
|---|---|---|
| Fixed overhead | system-prompt tokens; tool-schema tokens (`provenance.tools.schemaHash` identifies the schema) | offline: `capture_initial_request.mjs` + tokenizer |
| Injected context | automatic repository-context tokens per request; retrieval keywords | needs a trace field (keywords are emitted as a `plan` event but not recorded) |
| Orchestration | extra model calls (critic, compaction summaries); replans; compactions | partly (`agentDiagnostics.replans`, `trace.compactions`) |
| Tool surface | tools exposed vs used; invocation failures | yes (advertised list, tool calls, `recoverableToolErrors`) |
| Progress | turns/tokens to first file modification; repeated identical reads/searches | needs trace analysis |
| Outcome | empty-patch rate; official resolve rate | yes |
| Cost | prompt/completion tokens; wall-clock (contended) | yes |

The headline derived quantity is the **scaffold share**: fixed overhead plus
injected context, divided by the input budget. For the same harness this share
is twice as large for Solar (3,686) as for the 16K models (7,372).

### Two tracks

**Track A: public harness comparison.** Run real systems (upstage-cli,
mini-SWE-agent, then SWE-agent/OpenHands if feasible) under KAB's task
identity, sandbox, evaluator and accounting, with as little change to their
upstream behaviour as possible. This compares *systems*. It does not isolate
one cause.

**Track B: controlled single-factor ablations.** Start from the v1 harness
(B0 = upstage-cli `802cddd`, v1 envelope) and change one factor at a time:

| Factor | Levels (initial) | Owner of the switch |
|---|---|---|
| F1 tool interface | v1 argv-split shell · quoted/`sh -c` shell in the same container · reduced tool set | KAB (sandboxed-tools wrapper) |
| F2 retrieval query | v1 (first 8 tokens of input) · issue-only · none | upstage-cli (a genuine product fix, reviewed upstream, behind a switch) |
| F3 context policy | v1 compaction · history-window variants | upstage-cli |
| F4 planning | v1 replanning + critic · off | upstage-cli |
| F5 termination | v1 · edit-nudge before the turn limit | upstage-cli or KAB |
| F6 budget envelope | output reservation; context 16K vs 32K (where the server is validated); turns | KAB config + serving |

Budget (F6) is **always** analysed separately from F1–F5. Each level is
recorded as `budgetId`, separately from `harnessId`. Interactions come after
the single-factor results, and only for factors that showed an effect.

### Hypotheses

- **H1 (retrieval) [hypothesis]:** issue-derived retrieval changes
  time-to-first-edit and the empty-patch rate relative to v1. The direction is
  open: better files, but less room for the conversation.
- **H2 (output budget) [hypothesis]:** Kanana's truncation rate falls with a
  larger output reservation or a reasoning cap. Whether resolve rate follows
  is open.
- **H3 (tool interface) [hypothesis]:** a quoted shell lowers recoverable
  tool-error rates (Kanana 22.4%, A.X 14.2% in v1).
- **H4 (termination) [hypothesis]:** EXAONE's empty patches respond to a
  termination/edit policy more than to extra turns.
- **H5 (burden) [hypothesis]:** the effect of adding scaffolding is more
  negative as the scaffold share of the input budget grows: the
  harness × budget interaction.

### Controls and fairness

Constant within a comparison: instance set and order, base commits, official
images (digest recorded), prompt template (or a documented per-harness
deviation), served checkpoint/revision/runtime/sampling (preflight
REPORTABLE), sandbox flags, official scorer version, and the denominator
(every scheduled instance, no exclusions). Every run records
`provenance.agentHarness` (§6). A run without a pinned descriptor is not
reportable. Prompts and policies are preregistered before any model sees a
v2 instance.

### Validity threats

- **Power.** Resolve rates of 0–8% on n=50 cannot separate small effects. The
  pilot must produce a power analysis. Intermediate outcomes (empty-patch
  rate, truncation, time-to-first-edit) are more sensitive but are not
  substitutes for resolution.
- **Docker storage** limited v1 to stage 1. A larger n needs image rotation or
  more storage (owner decision).
- **Track A confounds:** each public harness has its own system prompt and
  output parser, and a model's chat template may fit one harness better.
- **Contention:** wall-clock budgets on a shared machine (§3C).
- **Contamination:** public benchmarks may be in any model's training data.
- **Language:** everything is English. No Korean-language claim follows.
- **Solar:** unofficial NVFP4 weights, a different runtime, and an 8K
  validated context. Do not assume it runs at 32K.

## 6. Implementation foundation (done 2026-11-08)

`harness/src/agent/harness-config.mjs` defines `kab.agent-harness/v1`:

```text
descriptor = {
  schema: "kab.agent-harness/v1",
  implementation: { name, kind: in-process|subprocess, version, revision (40-hex|null), dirty, adapterSha256 },
  policies: { toolInterface, retrieval, context, planning, termination }   // each { id, ...params }
  budget:   { maxTurns, maxToolCalls, timeoutSec, maxOutputTokens, contextLimit, outputReservation, safetyMarginRatio }  // number|null
}
record = descriptor + harnessId (implementation incl. KAB adapter source hash + policies) + budgetId (budget) + pinned
```

- **Vocabulary.** `provenance.harness` is KAB's *evaluator*;
  `provenance.agentHarness` is the scaffold under test. Model identity is
  rejected inside the descriptor and stays in `provenance.model`.
- The upstage-cli adapters emit a descriptor whose policy ids name upstream
  behaviour *at the pinned revision*. upstage-cli has no switches for these at
  `802cddd`; the params are only what KAB controls.
- `TaskRunner` validates and records it. An invalid descriptor makes the run
  `status=error`. An adapter that declares nothing records `null` (mock and
  replay agents, v1 behaviour).
- Tests: `h32` (contract, an external-kind adapter through the runner, the
  retrieval and shell characterizations) and `h30` (the recorded budget equals
  the budget actually sent).

v1 agent behaviour is unchanged. The adapters pass the same loop budget, and
v1 run records are not rewritten.

## 7. Next: integrating mini-SWE-agent (Track A, first system)

Proposed adapter (`subprocess` kind). **Not implemented.**

1. Pin a mini-SWE-agent release (version and commit) in an isolated venv under
   `.cache/`, through `benchmarks/setup.sh` with a hash check, like the BFCL wheel.
2. Run it as a Python subprocess on the host with **a KAB environment class**.
   Its `execute(action, cwd, timeout)` forwards each command over a JSON-lines
   pipe to the Node adapter. The adapter runs it with
   `context.executor.execShell` in the task's own hardened container and
   returns `{output, returncode}`. The sandbox, image, mount and network policy
   stay KAB's. The host process makes only model HTTP calls.
3. Model: litellm `hosted_vllm/<servedModelName>` with `api_base` from
   `local-models.mjs`. Sampling and `max_tokens` are taken from the same
   config, and preflight is required.
4. The patch is KAB's workspace diff (PatchTracker), not the agent's
   submission output. Record this as a documented deviation from `mini-extra swebench`.
5. Descriptor: `name: "mini-swe-agent"`, `kind: "subprocess"`, version and
   commit, `toolInterface.id: "mini.bash"`, the step limit mapped to
   `budget.maxTurns`, and the config file's hash as a policy param.
6. Offline validation before any model: a replayed model (scripted litellm
   responses) solves a synthetic fixture through the bridge; gold, empty and
   wrong patches score as expected with the official evaluator. This mirrors
   `results/swebench-offline-validation-2026-10-29/`.

## 8. What would be a genuine contribution

- Single-factor causal estimates of scaffold components for open, locally
  served models under realistic local budgets, with full provenance. This is
  in contrast to system-level leaderboard comparisons.
- A measured harness × budget interaction (H5) using a scaffold-share metric
  computed from server-counted tokens.
- Documented, testable mechanisms (such as §3A) instead of post-hoc stories.
- A reusable evaluator contract that swaps the agent harness while holding the
  task identity, the sandbox and the official scorer fixed.

Roadmap: [`../ROADMAP.md`](../ROADMAP.md).
