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

### Official evaluator, offline (2026-11-08)

`benchmarks/swebench/validate_mini_offline.py` runs `harness swebench run
--agent mini-swe-agent` on the official instance `psf__requests-6028` (its
official image, KAB's Docker sandbox, mini 2.4.6 with its verified install)
with a **scripted** model that follows upstream's submit instructions. The
submission goes through `harness swebench predictions` to the **official**
evaluator: replayed gold patch **resolved**, empty submission
**empty_patch**, ineffective diff **unresolved**. Each case also checks model
identity (checkpoint, endpoint, sampling actually sent), the pinned harness,
identical `harnessId`/`budgetId` across cases, `prediction_source =
agent_submission`, stop reason `done`, one sandboxed action per model step,
the kept trajectory, and that the submission equals git's diff of the
replayed change. Pipeline checks, not scores; outputs stay under `.cache/`.

### Security fix found by the independent review (affects v1 code too)

Before 2026-11-08, `PatchTracker` ran host `git add`/`git diff` inside the
agent-writable workspace. An agent that set `core.fsmonitor`, a filter or
diff driver, or a `post-index-change` hook in the workspace `.git` could make
the **host** run a command at patch capture. This was reproduced with git 2.43.
The tracker now uses a harness-owned git directory outside the workspace, with
no system or global config, hooks and fsmonitor off, and no external diff or
textconv. The workspace `.git` is only touched before the agent starts
(h4 regression tests fail on the old tracker). It landed separately, ahead
of this integration (PR #16), with one more fix: the test patch is applied
from stdin, not from a file in the workspace. **v1 audit:** none of the 3,716
tool calls recorded in the 200 local main-campaign SWE-bench records touches
git config, hooks, attributes or `.git`, and no v1 patch touches `.git`.

### First live integration smoke (2026-11-09, supervised)

Integration validation, **not** a benchmark result. One EXAONE 4.5 FP8
session (thinking on, 16K) through the shared GPU queue (`gpuq` job 55,
`kserve-session.sh`, GPU 0, healthy after ~220 s, released and the container
removed). Serving preflight REPORTABLE (15 verified, 0 mismatches). One
synthetic two-function repository (no SWE-bench content) through mini 2.4.6
and the KAB DockerSandbox, budget 30 calls / 900 s. Counts-only evidence:
`results/live-smoke-2026-11-09/` (raw record under `.cache/`, not committed).
The smoke ran **before** the per-call instrumentation below existed; its
per-call figures come from mini's native trajectory, and the new
`trace.modelCalls` path has been tested offline only, not against a real
model.

[measured] 15 model calls, 15 tool calls (one per call), 0 format errors;
two failed commands (`git diff --calc.py`) that the model corrected itself;
stop reason `done` (upstream `Submitted`) after 66 s; the submission is the
one-line fix, applies to the base and is the prediction. Model, harness and
budget identities recorded. Prompt tokens grew from 1,024 to 4,097. Run
totals in `metrics`: 37,616 prompt + 2,020 completion = 39,636 tokens. Every
one of the 15 responses carried usage, so these equal the sums of the
provider-reported values (the old bridge would have counted a missing value
as 0; none was missing).

One task on one trivial repository says nothing about EXAONE's capability
with mini or about any other model.

### Observability and context audit (2026-11-09, CPU only)

**Usage was recorded; per-call records were not.** [measured] The smoke
summary printed `usage: null` because it read `run.trace.usage`, a field
that does not exist; the totals were in `run.metrics` all along.
`trace.turns` *was* empty: `AuditLog` builds turns only from upstage-cli's
`thinking` events, which mini never emits. The same mechanism is wrong for
upstage-cli too: a v1 run with 30 model calls has one `trace.turns` entry
(it opens a turn once per event batch). `trace.turns` is left as it is (v1
records use it) and is not a per-call record for either harness.

**`trace.modelCalls` (new, `kab.model-call/v1`).** The bridge wraps
`model.query` for observation only (arguments, return value and exceptions
pass through; prompts, sampling, termination and command execution are
unchanged, h33). Each record is streamed to the adapter as the call ends,
so calls made before a later failure (bridge killed at the deadline, an
infrastructure error) stay in the run record. One record per mini model call
(upstream's HTTP retries of one call are inside it):

| Field | Meaning |
|---|---|
| `index`, `startedAt`, `durationMs` | call order; wall clock of the call, including upstream's retries/backoff for it |
| `outcome`, `error` | `response` · `format_error` (a reply mini could not parse; still a model call) · `error` (no response, e.g. a context-length rejection) |
| `promptTokens`, `completionTokens`, `totalTokens`, `reasoningTokens` | the provider's own usage fields, or `null`. litellm turns an absent usage block into zeros; prompt = total = 0 is that placeholder and is recorded as `null` (a chat prompt is never 0 tokens) |
| `reasoningChars` | characters of returned reasoning text, or `null`; parser-independent (Kanana's `deepseek_r1` parser always reports `reasoning_tokens` 0, `local-models.mjs`) |
| `finishReason`, `toolCallsRequested` | from the response |
| `firstToolCall`, `toolCallsExecuted` | the slice of `trace.toolCalls` this call's actions produced (an action after a submission is not executed) |

`metrics.promptTokens/completionTokens/totalTokens/reasoningTokens` are now
exact sums over the calls that returned a response, or `null` when any of
them lacks the value (never 0 for unknown); `metrics.modelCalls` counts every
call and `metrics.failedModelCalls` those without a response, whose prompt
(e.g. a rejected 16K+ prompt) is therefore **not** in the token totals. A
cost estimate with unknown usage is now `null`, not 0. Limit: litellm also
fills a *partly* missing usage block with 0s, which cannot be told apart from
a real 0; vLLM always sends complete usage. mini's native
trajectory stays in `trace.agentTrajectory`, unchanged. The adapter sources
are part of `adapterSha256`, so mini's `harnessId` changes with this
instrumentation even though its behaviour does not; runs before and after
are distinguishable, as intended.

**Earlier reasoning is re-sent and re-tokenized.** Three layers, separated:

1. *mini stores* each assistant message as litellm returns it, including
   `reasoning_content`; `_prepare_messages_for_api` drops only `extra`.
2. *litellm sends* it: replaying the 15 recorded calls through mini's own
   `LitellmModel` to a capture server
   (`benchmarks/mini-swe-agent/audit_request_history.py capture`) gives
   request bodies in which every earlier assistant message carries
   `reasoning_content` (15/15 calls; h33 asserts it on the wire).
3. *the server tokenizes* it: EXAONE's chat template keeps an assistant
   message's reasoning when it comes after the last user message with
   string content, which in mini's loop is the task prompt, so every
   earlier turn qualifies. Rendering each captured body with the checkpoint's
   own `chat_template.jinja` and tokenizer (`... tokenize`) reproduces the
   server's `prompt_tokens` **exactly on 15/15 calls** with reasoning, and on
   1/15 (the first call, which has none) without. [measured] The difference
   at call *k* equals exactly the provider-reported reasoning tokens of calls
   0…*k*−1: 718 of 4,097 prompt tokens at the last call; 5,699 of 37,616
   prompt tokens (15.2%) over the run.

This is EXAONE's template doing what it is written to do for a tool loop
within one user query; it is not a mini bug. **upstage-cli differs**:
[derived from code, `802cddd` `src/agent/loop.mjs`] it appends assistant turns
to history as `{role, content, tool_calls}`, so earlier reasoning is not
sent back. The two harnesses therefore spend the same 16K differently by
construction (§8).
Rendering was done with transformers, not vLLM's own code; the exact match on
every call is the evidence that it is the same rendering.

**Context limit (vLLM 0.32.0, from the pinned image's source).** [derived]
The prompt alone may use the full `max_model_len` (16,384); `max_tokens` is
clamped to 16,384 − prompt (`entrypoints/serve/utils/api_utils.py`
`get_max_tokens`); a longer prompt is rejected with HTTP 400 "This model's
maximum context length is 16384 tokens. However, your prompt contains N
input tokens…" (`renderers/params.py`). The earlier reading that 8,192 tokens
are reserved for output was wrong. Near the limit a mini run therefore sees
cut-off replies first (`finish_reason=length`, which upstream answers with its
truncation feedback as a format error), then the 400. litellm maps that 400
to `ContextWindowExceededError`, which mini does not retry; the run ends
`context_exhausted` with an empty submission. Tested offline (h33, the
server's exact error text): one request, no retry, no submission although a
`patch.txt` exists, partial-run provenance intact, not an infrastructure
error. The full-history policy is unchanged; any pruning would be a separate,
named condition with its own `harnessId`.

[hypothesis] At this smoke's growth (~220 prompt tokens per call, plus
re-sent reasoning) a run reaches 16K after roughly 50–70 calls; SWE-bench
observations are much larger, so `context_exhausted` before mini's 250-step
limit is the expected ending on real instances. Not yet observed live.

### Not yet done

- No mini run on a real SWE-bench instance with a real model.
- The upstream retry loop (tenacity in mini's model client) is kept. A dead
  server therefore takes upstream's backoff before the run ends as an
  infrastructure error (now visible as `durationMs` of the failed call).
- upstage-cli has no per-call record (`trace.modelCalls` is `null` for it);
  its `token_usage` events turn missing usage into 0 and skip calls without
  usage. Needed before the pilot (§8).

## 8. First controlled comparison: pilot protocol (proposed, not run)

**Question.** Can upstage-cli and mini-SWE-agent be compared as systems
(Track A) on the same served model, instances, limits and official
evaluator, with accounting that means the same thing in both? This pilot
checks feasibility and measurement; it estimates no effect and ranks nothing.

**Held constant.** EXAONE 4.5 33B FP8 at `69570ad5`, thinking on, vLLM 0.32.0
by digest, `max_model_len` 16,384, sampling from `local-models.mjs`, preflight
REPORTABLE at the start of each session; served through `kserve-session.sh`
under `gpuq`. Same instance images (digest recorded), same KAB DockerSandbox
flags, same `ENVELOPE` wall clock (2,700 s), memory and CPUs; official
evaluator; every scheduled attempt is in the denominator.

**Instances.** The three development instances already used for pipeline
work, never the 50 main-comparison instances: `psf__requests-1724` and
`psf__requests-2931` (the v1 pilot ids, chosen disjoint from
`subset-v1.json` by `make_campaign.py`), and `psf__requests-6028` (offline
validation). Their images are local (3.6–3.8 GB each, ≈11 GB); no pulls.

**Arms.** Turns are not a common unit: an upstage-cli turn is one loop step
that may run several tools (and its planner/critic may make extra calls),
while a mini step is exactly one model call. So no arm is "30 turns in both".

| Arm | Harness | Native budget | `budgetId` |
|---|---|---|---|
| A | upstage-cli `802cddd`, v1 envelope (7 tools, English prompt) | 30 turns, 60 tool calls, 2,700 s, 8,192 output reservation | as v1 |
| B | mini 2.4.6, upstream `swebench.yaml`, full history | 250 calls (upstream), 2,700 s | new |
| B30 | as B | 30 calls, 2,700 s | new (a sensitivity arm matched by call count, not a turn-matched control) |

3 instances × 3 arms × 2 repeats (no seed control on the server) = 18 attempts.

**Differs by construction (the native policies are what Track A compares;
each is recorded, none is equalized).**
- *Input budget.* upstage-cli reserves 8,192 tokens for output in its context
  budget (ADR 0011), so its input budget is 7,372 tokens (§5); mini sends
  `max_tokens` 8,192 but vLLM clamps it, so mini's prompt can grow to the
  full 16,384. mini gets roughly twice the input context. Recorded as peak
  prompt tokens per attempt. A mini arm capped at an 8K input would need a
  KAB-side guard, i.e. a new `harnessId`; it is not in this pilot.
- *Reasoning in history.* mini re-sends earlier reasoning (15.2% of the
  smoke's prompt tokens); upstage-cli does not.
- *Prompts, tools and parsers.* Each harness's own system prompt, tool
  surface and output parser (§5, Track A confounds).

**Common accounting per attempt** (all from the run record):

| Quantity | Definition |
|---|---|
| model calls | HTTP chat completions issued by the harness, including format errors and failed calls (`trace.modelCalls`) |
| tokens | server-reported prompt, completion, reasoning; sums over answered calls; `null` if any is missing; peak prompt tokens; re-sent reasoning tokens (mini: from the audit; upstage-cli: 0 by construction) |
| tool actions | commands/tools executed in the sandbox (`trace.toolCalls`), and the failed ones |
| wall clock | agent time (contended machine; reported as such), plus per-call `durationMs` |
| termination | common stop reason (`done`, `budget_exhausted`, `context_exhausted`, `model_protocol_error`, infrastructure error) |
| outcome | official evaluator: resolved / unresolved / empty patch / error, with the prediction source |

**Prerequisites (blockers).**
1. Per-call records for upstage-cli: a KAB-side wrapper around the model
   adapter that KAB already constructs (no submodule change), producing the
   same `kab.model-call/v1` records. Without it, "model calls" and token
   totals are not comparable.
2. A v2 driver that submits one `kserve-session.sh` session, runs the 18
   attempts in a fixed interleaved order, runs predictions and the evaluator,
   and records a manifest (`results/` stays v1-only until a protocol ADR).
3. A preregistration (this section, frozen by an ADR) before any model sees
   these instances under v2.

**Resources (estimates).** GPU: one queue session on 1 GPU; ~4 min to
healthy. Arm A: v1 EXAONE median 149 s per attempt, max 918 s (50 main
attempts; contended). Arms B/B30: unknown; hard ceiling 2,700 s each. Expected
total about 1.5–3 h of GPU time; worst case 18 × 45 min = 13.5 h, so the
session lease should be 4 h with a stop rule (any infrastructure error or an
unexpected queue/server event stops the pilot, no automatic retry). An
attempt cut off by the lease ending is recorded as an infrastructure error and
stays in the denominator; attempts not started are listed as not executed, and
the pilot is reported as incomplete rather than resumed silently. Docker: no
new images; one container per attempt (upstage-cli) or per action (mini); run
records with trajectories are ~0.1–1 MB each. Evaluation: 18 predictions on
CPU with local images.

**Not answered by the pilot.** With 6 attempts per arm, resolution
differences are not interpretable; the outputs are the accounting itself,
stop-reason distributions, context exhaustion, and a power analysis for a
real comparison.

## 9. What would be a genuine contribution

- Single-factor causal estimates of scaffold components for open, locally
  served models under realistic local budgets, with full provenance. This is
  in contrast to system-level leaderboard comparisons.
- A measured harness × budget interaction (H5) using a scaffold-share metric
  computed from server-counted tokens.
- Documented, testable mechanisms (such as §3A) instead of post-hoc stories.
- A reusable evaluator contract that swaps the agent harness while holding the
  task identity, the sandbox and the official scorer fixed.

Roadmap: [`../ROADMAP.md`](../ROADMAP.md).
