# ADR 0008 — Observed serving configuration: read-only preflight, fail closed

## Status

**Accepted** (2026-10-29). Implemented in `harness/src/preflight/serving.mjs`;
tested in `harness/tests/h26` and `h27`. **Not yet exercised against a live
server** (no model server may be started in this session).

## Context

Run records carried `provenance.model` copied from `local-models.mjs`:
what the harness *believes* the server is. The pilot already produced a
record claiming `contextLimit: 8192` for a Solar server launched at 4096
(`harness/docs/PILOT_REPORT.md`). The Solar launcher defaulted to 4096 and
started its image by tag, so the recorded digest was an assumption.

## Decision

1. **A read-only verifier** compares declared with observed configuration,
   per field, as `verified`, `declared_only`, `mismatch` or `unavailable`.

   | Field | Observed from | Critical |
   |---|---|---|
   | endpoint, servedModelId, maxModelLen | `GET {baseUrl}/models` (`id`, `max_model_len`) | yes |
   | container (exists, running) | `docker inspect <containerName>` | yes |
   | servingImage | container `.Image` → `docker image inspect` `.RepoDigests` ∋ declared digest | yes |
   | checkpointRevision | `/snapshots/<sha>` in the API's `root` **and** the container's model argument | yes |
   | servedModelNameArg, tensorParallel, maxModelLenArg, reasoningParser, toolCallParser (+ `--enable-auto-tool-choice`), maxNumSeqs, logitsProcessor | container args | yes |
   | gpuDevices (≥ TP devices visible) | container env `NVIDIA_VISIBLE_DEVICES` | yes |
   | harnessClean, upstageCliPin, upstageCliClean | git | yes |
   | quantization, sampling, servingRuntime | not observable this way | no (`declared_only`) |

2. **Fail closed.** A run is reportable only if no field is `mismatch` and
   no critical field is `unavailable`. A remote server whose container cannot
   be inspected is therefore not reportable; that is deliberate.
3. **Honest limits.** The checkpoint check proves which HF snapshot
   *directory* was served (named by commit SHA), not that its files match
   the Hub. Sampling is sent by the harness per request and cannot be
   observed server-side; parameters left unset fall back to model defaults.
   Quantization is read by vLLM from the checkpoint and not exposed.
4. **Entry points.** `harness preflight --agent <model> [--json]` (exit 0
   reportable / 1 blocked); `harness run --preflight` refuses to start a
   blocked run (exit 3) and stores the result in `provenance.preflight`.
5. **Launchers.** `models/serving-records/` stays frozen evidence. The
   maintained launchers are `models/serving/`. The Solar launcher there
   defaults to 8192, starts by the pinned digest, refuses an image that does
   not resolve to it (`SOLAR_ALLOW_UNPINNED=1` overrides, and such a run then
   fails preflight), and has a side-effect-free `print-config`. The shared-GPU
   gate is unchanged. `h27` checks that the launcher's exact arguments pass
   the preflight.

## Consequences

- A reportable run now carries evidence of what was served, not only of
  what was intended.
- Until the first live check, the field mapping (in particular the shape of
  vLLM's `/v1/models` and `docker inspect .Args` for these images) is tested
  against fixtures written from vLLM's documented API and the launchers, not
  against the real servers. The first controlled live run must start with
  `harness preflight` and record its output.
- Not covered: generation-config defaults inside the checkpoint, the GPU
  memory actually free at run time, driver/CUDA versions inside the
  container, and file-level checkpoint integrity.
