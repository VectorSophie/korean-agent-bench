# Critique Gate A — pre-inference review (2026-10-29)

An independent reviewer (a separate agent instructed to invalidate the
experiment, read-only) examined the full measurement path before any live
inference: context budget, serving verification, BFCL and SWE-bench
generation and scoring, the campaign runner and resume logic. Each finding was
then reproduced or rejected here before remediation. Additional defects were
found by dry runs of the campaign runner against fake servers.

**Outcome: 1 blocker and 7 material issues confirmed and fixed; 4 minor
issues fixed or documented; 6 suspected failure points not reproduced.** No
live inference was run before the fixes below were in place and tested.

## Findings and remediation

| # | Finding | Class | Reproduced | Remediation | Evidence |
|---|---|---|---|---|---|
| 1 | SWE-bench workspace was a full clone: 3,575 commits newer than `base_commit` (including the gold fix) reachable with `git log --all` from `run_shell` | **BLOCKER** | yes (psf/requests) | Workspace is a new repository whose single commit is `base_commit`'s tree, built through a temporary index; `run` fails closed without it; clones happen only in a serial `prepare` step. The official image's own `/testbed` was checked: HEAD = base + one setup commit, 0 later commits, 0 unreachable objects | `harness/src/benchmarks/swebench.mjs` `prepareSnapshot`; `tests/h29` (one commit, gold commit unreachable, `fsck` empty, cache clone untouched); real snapshot of psf__requests-6028: 1 commit |
| 2 | BFCL irrelevance categories score any non-call as correct, including truncated outputs and caught inference errors; BFCL sends no `max_tokens`, so thinking models can run to the context limit | MATERIAL | yes (code) | The model's validated `max_tokens` is sent; a per-response diagnostics file records `finish_reason`, usage and empty outputs; analysis reports irrelevance with errors/truncations flagged next to the official score | `benchmarks/bfcl/kab_bfcl.py`; offline validation asserts `max_tokens` in every request |
| 3 | BFCL error classification on free-text regex: a 404 (wrong model) or 400 (missing parser flag) counted as model errors; `503` matched inside entry ids | MATERIAL | yes | Classified on exception type / HTTP status: transient → retried (≤ 2); server rejections (`NotFoundError`, `BadRequestError`, 4xx) → **configuration**, run aborted and never scored; context-length → context | `campaign.py` `classify_bfcl_error`; checked on the reviewer's six counterexamples |
| 4 | No preflight at BFCL generate time (a stale `session.json` sufficed) | MATERIAL | yes | REPORTABLE preflight before every generate round; real campaigns require a clean tree (harness, benchmarks, datasets, models/serving, submodule) | `campaign.py` `run_preflight`, `require_clean` |
| 5 | Instances without a run record silently left the SWE-bench predictions and counts; BFCL could score a subset of the ids | MATERIAL | yes (code) | Every campaign id needs a final attempt; `accounting.json` lists every id with its classification; ids without a run are not sent as empty patches and stay in the denominator; BFCL aborts on any id missing from or extra in the results; evaluator counts `not_reported` | `campaign.py` `swebench_eval`, `_bfcl`; `evaluate.py` |
| 6 | Concurrent clone race (46 django instances, concurrency 4) and network access mid-campaign | MATERIAL | yes (code) | Serial `prepare` step; runs never clone | `campaign.py prepare`; `harness swebench prepare` |
| 7 | Configuration hash ignored harness code, tool versions, prompt template | MATERIAL | yes | Hash covers git trees of `harness/`, `benchmarks/`, `models/serving/`, the submodule gitlink, bfcl-eval/swebench versions, prompt-template sha, BFCL temperature; content-addressed so documentation commits do not block a resume | `campaign.py` `config_hash` |
| 8 | Unequal input budgets and a common wall clock across models of very different speed | MATERIAL (fairness) | yes (by design) | Not changed silently: these follow from each model's validated serving profile. Pre-registered as conditions in the protocol (Gate B), `context_exhausted` and `budget_exhausted` reported per model | protocol freeze ADR |
| 9 | SWE-bench: an empty or malformed model turn re-thrown as infrastructure and retried | MATERIAL (lower) | yes | `[protocol]` errors about the model's message (empty turn, malformed tool call) → outcome `model_protocol_error`; transport/5xx/timeouts stay infrastructure | `harness/src/agent/adapters/local.mjs`; `tests/h30` |
| 10 | BFCL multi-turn history echoed reasoning back to the model | MINOR | partly (client side) | Upstream's own reasoning-strip semantics applied to both vLLM field names; reasoning kept in the result file | `kab_bfcl.py` |
| 11 | BFCL temperature 0.001 vs vendor 0.6 for thinking models | MINOR | — | Kept (BFCL's own setting, uniform); documented as a limitation | protocol |
| 12 | SWE-bench images are `:latest` tags; sandbox could pull implicitly; disk budget unenforced | MINOR | yes | Images pulled once in a paced step with digests logged; each attempt checks the image is present (no implicit pulls); budget enforced on Docker's deduplicated image size | `campaign.py` `pull_images`, `swebench_attempt` |
| 13 | Subprocesses without timeouts | MINOR | yes | Timeouts on agent runs (agent budget + 15 min), generate (24 h), evaluate (12 h) | `campaign.py` |
| 14 | Resume edge: interrupted run directory reused; two processes on one model | MINOR | yes (code) | Stale run directories renamed, never reused; per (campaign, model, benchmark) lock | `campaign.py` |

Found by dry runs (not by the reviewer):

| Finding | Class | Remediation |
|---|---|---|
| Configuration hash included the env-dependent endpoint URL; restarting on another port refused a legitimate resume | MATERIAL | URL excluded (identity verified by preflight); resume re-tested across ports: 0 new requests |
| A blocked per-run preflight was treated as a retryable infrastructure failure and consumed all retries | MATERIAL | Campaign halts, no attempt recorded |
| SWE-bench sandbox: official images keep pytest and dependencies in the `testbed` conda env, not on the default PATH, so the agent's `python`/`pytest` failed for environmental reasons | MATERIAL | Task-level `sandbox.env` (PATH only) puts the testbed interpreter first; 4 GB / 2 CPUs; `tests/h31` in the real image |

## Not reproduced

Context budget not reaching the request; excessive repository context;
uncounted tool-schema tokens; tool parser, model id or checkpoint mismatches
across launchers, `local-models.mjs`, `models.json` and docs; patch capture.
Evidence: `tests/h30`, `tests/h28`, preflight design (ADR 0008), offline
validations.

## Verification after remediation

Unit and Docker suites, BFCL offline validation (official scorer: gold 100%,
invalid 0%, `max_tokens` sent), SWE-bench offline validation with snapshot
workspaces (official evaluator: gold resolved, empty/wrong/malformed as
expected, captured patches equal git's canonical diff), campaign dry runs
(injected 503s retried and quarantined; resume; halt on blocked preflight).
