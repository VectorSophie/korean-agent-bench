# Harness v2: When does scaffolding become a burden?

Status: **design, 2026-11-08; mini-SWE-agent integrated offline (§7).**
Nothing in this document has been run on a model. Sections are labelled **[measured]** (evidence in this repository),
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
sandbox. **Done (2026-11-08):** `buildTaskV2` → `kab.task/v2` (no `agent`
block, raw problem statement). The runner refuses v1 adapters on it and
requires a pinned descriptor.

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

## 7. mini-SWE-agent: first external harness (integrated offline, 2026-11-08)

**State:** integrated and validated **offline only**. No model has run through
it, and it has produced no score.

| | |
|---|---|
| Upstream | mini-swe-agent **2.4.6**, tag `v2.4.6` = `a83fcae82d2a…`, MIT, Python ≥ 3.10 |
| Install | `benchmarks/setup.sh mini` → `.cache/venv-mini`. Wheel sha256 is enforced. Dependencies come from `benchmarks/mini-swe-agent/requirements.lock` (exact versions) |
| Lock rule | the declared requirements resolved with `pip --uploaded-prior-to` the 2.4.6 upload time. Newer litellm (1.108.3) fails every tool-call request without the undeclared `mcp` package, so "latest" was not reproducible |
| Config | upstream `config/benchmarks/swebench.yaml`, sha256 `9a9c86ac…` checked by both Node and Python |
| Code | `harness/src/agent/adapters/mini-swe-agent.mjs` (adapter), `harness/src/agent/mini/kab_bridge.py` (bridge) |
| Run | `harness swebench run --instance <id> --agent mini-swe-agent --model <key> [--preflight]`, which builds a `kab.task/v2` task |

### How it runs

mini's own `DefaultAgent`, `LitellmModel` (`hosted_vllm/<served name>`, the
local endpoint), templates and submission check run unchanged in a Python
subprocess with a scrubbed environment: no host credentials, proxies or mini
user config. Only the environment class is KAB's: `KabBridgeEnvironment` sends
each bash action over a pipe to the Node adapter. The adapter runs it in the
task's `DockerSandbox` (hardened, `--network none`, only the workspace
mounted) and returns `{output, returncode, exception_info}`. The bridge
executes nothing itself. Any other mini environment class is refused, and so
is a non-Docker sandbox.

### Deviations from `mini-extra swebench` (all recorded in `provenance.agentHarness`)

| Upstream | KAB | Why |
|---|---|---|
| repository at `/testbed` in the image | KAB snapshot mounted at `/workspace`. The prompt's `/testbed` is substituted (`implementation.config.promptSubstitutions`) | the sandbox mount point is fixed by upstage-cli's `docker-flags.mjs` (a cross-repo contract) |
| one long-lived container, `docker exec` per action | a fresh hardened `docker run` per action, with the workspace persisted by the bind mount | KAB's sandbox model. State outside the workspace (`/tmp`, installs) does not persist. `toolInterface.containerPerAction` |
| root user, `BASH_ENV=/root/.bashrc` activates conda | unprivileged user, `BASH_ENV` dropped, the task `PATH` selects the testbed interpreter | otherwise bash prints "Permission denied" into every observation and into the submitted patch (found by h34) |
| `stderr=STDOUT` at the process level | `exec 2>&1; ` prepended inside the container | keeps stderr in order with stdout, as upstream does |
| `step_limit: 250`, `cost_limit: 3` | `step_limit` = `budget.maxTurns` (default 250), `cost_limit` off (local model), wall clock = task timeout | budget is an experimental variable (`budgetId`) |
| `model_kwargs` for a hosted API | `api_base`, `max_tokens` and sampling from `local-models.mjs`. `top_k` and `chat_template_kwargs` go through `extra_body` (asserted at the server) | model identity is KAB's |
| unbounded output | per-stream cap of 8,000,000 characters; past it the action returns returncode −1 with an exception, so a cut-off submission is never accepted | host memory; fail closed |
| agent's symlinks untouched | after each action, links the agent created that point outside `/workspace` (as the container resolves them) are removed. The note goes to `exception_info`, never to the output. The repository's own links are kept | host-side safety, as in v1 |
| wall clock checked only before each model call | the same, plus a hard kill of the bridge at task timeout + 900 s, recorded as `budget_exhausted` | a hung request must not hold the slot forever |
| trajectory file | mini's trajectory is stored in the run record (`trace.agentTrajectory`, local raw records only) | provenance |

**Prediction:** mini's submission (the text after
`COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT`) is the prediction, as upstream writes
it. The run records `patch.prediction_source: "agent_submission"`,
`patch.agent_submission`, and the workspace diff (`patch.model_patch`)
alongside. The workspace diff includes the agent's own files, such as `patch.txt`.

### What is real and what is faked in the tests

| | h33 (unit, CI) | h34 (Docker tier, local) |
|---|---|---|
| mini loop, litellm client, swebench.yaml, bridge, adapter, runner, provenance | real | real |
| model | scripted OpenAI-compatible HTTP server | scripted HTTP server |
| container | in-process fake executor (simulated effects; nothing runs on the host) | **real** `DockerSandbox` on the official SWE-bench image |
| repository | synthetic | synthetic (no SWE-bench content) |

h34 checks that the edited code runs in the container, that the submission is
byte-identical to `git diff` (well under the output cap) and applies to the base, and that `--network none`,
the read-only root, escaping-symlink removal and in-order stderr all hold.
Negative tests (h33) cover host execution, a cwd outside the mount, malformed
commands, a foreign environment class, a modified config, a v2 run without a
pinned descriptor, and a v1 adapter on a v2 task.

### Security fix found by the independent review (affects v1 code too)

Before 2026-11-08, `PatchTracker` ran host `git add`/`git diff` inside the
agent-writable workspace. An agent that set `core.fsmonitor`, a filter or
diff driver, or a `post-index-change` hook in the workspace `.git` could make
the **host** run a command at patch capture. This was reproduced with git 2.43.
The tracker now uses a harness-owned git directory outside the workspace, with
no system or global config, hooks and fsmonitor off, and no external diff or
textconv. The workspace `.git` is only touched before the agent starts
(h4 regression tests fail on the old tracker). **v1 audit:** none of the 3,716
tool calls recorded in the 200 local main-campaign SWE-bench records touches
git config, hooks, attributes or `.git`, and no v1 patch touches `.git`.

### Not yet done

- No live model run, and no official evaluation of a mini prediction (the
  replay validation of `results/swebench-offline-validation-2026-10-29/`
  covers the evaluator, not this harness).
- The upstream retry loop (tenacity in mini's model client) is kept. A dead
  server therefore takes upstream's backoff before the run ends as an
  infrastructure error.
- Trace accounting beyond turns, tool calls, tokens and finish reasons
  (roadmap milestone 4).

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
