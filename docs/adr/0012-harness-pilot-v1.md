# ADR 0012 — Harness v2 pilot v1: upstage-cli vs mini-SWE-agent (feasibility)

## Status

**Proposed** (2026-11-09). Not executed. The design is frozen by the hash of
its machine-readable spec, `benchmarks/pilot/harness-pilot-v1.json`
(sha256 `e19579c564520907cf82df75a8bcd1bfaf3e520c8baae42f599688d7335a57bd`);
the driver refuses a manifest written under any other spec. It becomes
**Accepted** when the owner approves it together with the open decisions
below; any change to the spec before then gives a new hash and a revised ADR.
After acceptance it is superseded, never edited.

## Context

Harness v2 asks when scaffolding becomes a burden (`docs/research/HARNESS_V2.md`).
Track A compares whole systems under KAB's task identity, sandbox, serving and
official evaluator. Before any comparison means anything, the two systems
must be measured the same way. This pilot tests that, on development
instances only. It is a feasibility pilot: **no model ranking, no harness
ranking and no significance claim can follow from it.**

Measurement parity in place (HARNESS_V2 §7–8):
- per-call records `kab.model-call/v1` for both harnesses (`trace.modelCalls`);
  logical calls, transport attempts and tool actions counted separately;
  unavailable values `null`;
- one instance specification (`instanceSpec`) mapped to each harness's native
  task (v1 task for upstage-cli, `kab.task/v2` for mini), verified before and
  after every attempt;
- the queue-held serving session (`kserve-session.sh`), run once live
  (2026-11-09).

## Decision

1. **Model.** EXAONE 4.5 33B FP8 (`LGAI-EXAONE/EXAONE-4.5-33B-FP8` @ `69570ad5`),
   thinking on, vLLM 0.32.0 by digest, 1 GPU, `max_model_len` 16,384, sampling
   from `harness/src/agent/local-models.mjs`. Serving preflight REPORTABLE at
   the start of every driver invocation; otherwise terminal stop.
2. **Instances.** `psf__requests-1724`, `psf__requests-2931`, `psf__requests-1142`:
   the first three under `make_campaign.py`'s pilot rule (psf/requests,
   disjoint from `datasets/swe-bench-verified/subset-v1.json`, ranked by
   `sha256('korean-agent-bench/pilot-v1:' + id)`). Never a main-comparison
   instance (an earlier draft's `psf__requests-6028` is in main stage 1 and
   was removed).
3. **Arms** (native policies; Track A):

   | Arm | Harness | Budget |
   |---|---|---|
   | A | upstage-cli `802cddd`, v1 task and envelope | 30 loop steps, 60 tool calls, 2,700 s, input budget 7,372 |
   | B | mini-swe-agent 2.4.6, upstream `swebench.yaml`, full history | 250 logical calls, 2,700 s, prompt up to 16,384 |
   | B30 | as B | 30 logical calls, 2,700 s (call-count sensitivity arm) |

4. **Repeats and order.** 2 repeats; 18 attempts. Order fixed by
   `harness pilot plan`: repeat blocks, each (instance, arm) once per block,
   interleaved by `sha256('kab/harness-pilot-v1:' + attemptId)`. Attempt ids
   `r<repeat>-<arm>-<instance>`.
5. **Resource ceilings.** One `gpuq -G 1` session through
   `models/serving/kserve-session.sh exaone 16384` with
   `KSERVE_LEASE_SEC=14400` (4 h); at most two sessions; 2,700 s per attempt;
   18 attempts; no image pulls except `psf__requests-1142` (owner approval);
   no other benchmark, model or harness.
6. **Stopping.** No automatic retry of anything. *Resumable* stop only when
   the lease would end before the next attempt could finish (checked before
   it starts); a later session continues the same schedule after a fresh
   preflight. *Terminal* stop on: an infrastructure error, a provenance
   failure (task identity, model identity, unpinned harness, missing per-call
   records, harness or budget identity changing within an arm), an attempt
   found interrupted, a changed instance snapshot or local image, a failed
   preflight, or any unexpected queue or server behaviour observed by the
   operator. A terminally stopped pilot is reported as incomplete and never
   resumed.
7. **Incomplete-run accounting.** Every scheduled attempt is in the
   denominator with one state: `done` (scored by the official evaluator),
   `infra_error`, `provenance_error`, `interrupted` or `not_executed`. Nothing
   is excluded or re-run after the fact.
8. **What is reported.** Per attempt, the common accounting (HARNESS_V2 §8:
   logical calls, transport attempts, tool actions, loop steps, tokens and peak
   prompt tokens, wall clock, stop reason, prediction source, official
   outcome), descriptively, per arm. Plus: stop-reason distributions, context
   exhaustion, effort per attempt, and a power analysis for a real
   comparison. Outputs stay under `.cache/`; a counts-only summary may be
   committed under `results/`.

## Open decisions for the owner (before acceptance)

1. **Pull the `psf__requests-1142` image** (about 3.6 GB). Without it the
   pilot cannot run as specified.
2. **`psf__requests-1724` gold check.** The official evaluator scores the bare
   gold patch `unresolved` in this environment: one PASS_TO_PASS test
   (`test_mixed_case_scheme_acceptable`) fails with a `ConnectionError` to
   httpbin. Every arm is capped at `unresolved` there. Either keep it (its
   accounting is still valid; outcomes flagged) or replace it with the next
   ranked candidates, each needing a pull and a gold check. `2931` resolves
   with its gold patch; `1142` is unchecked (image absent).
3. Approval of the live run itself (GPU, queue session).

## Consequences

- Any A-vs-B difference mixes harness design with **input budget** (7,372 vs
  up to 16,384 tokens) and **reasoning re-sent in history** (mini only). They
  are not an isolated effect of harness complexity. The matched-input
  condition `B-in7372` (HARNESS_V2 §8) is defined for a later, separately
  identified run; neither baseline changes.
- 6 attempts per arm cannot separate resolution rates; resolution is reported
  but not compared.
- Timings are contended (shared machine).

### Verified so far, and how

| Claim | Against | Not against |
|---|---|---|
| per-call records, transport attempts, null-not-zero, failed calls kept | the real upstage-cli loop and adapter (h36) and the real mini/litellm client (h33), each with a scripted OpenAI-compatible server that counts its HTTP requests | live inference |
| observation changes nothing | identical request bodies, tool calls, patches, trajectories with and without it (h33, h36), streaming unchanged (h36) | live inference |
| task identity across harnesses | real task builders and snapshot format (h37) | — |
| driver order, states, resumability, stops, evaluation, hashes | h37 (fake model); `benchmarks/pilot/validate_pilot_offline.py`: the real CLI on 1724 and 2931, real Docker sandboxes, official evaluator (12/12 attempts; mini arms reproduce the gold reference) | live inference, the real queue, 1142 |
| EXAONE request history and context limit | the live smoke's 15 recorded calls replayed (no inference); vLLM 0.32 source in the pinned image | a real SWE-bench instance |

Not verified anywhere yet: a real model on a real SWE-bench instance under
either harness, `context_exhausted` observed live, a queue-server restart
mid-session, a SIGKILLed session (orphaned container).
