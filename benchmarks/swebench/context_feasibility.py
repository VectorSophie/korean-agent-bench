#!/usr/bin/env python3
"""Preregistered context-feasibility report for the SWE-bench subset (ADR 0009).

    .cache/venv-bfcl/bin/python benchmarks/swebench/context_feasibility.py

Inputs: datasets/swe-bench-verified/subset-v1.json, the local instance export,
the captured initial agent requests (capture_initial_request.mjs), each model's
own tokenizer + chat template from the local HF cache (read-only,
local_files_only; nothing is downloaded), and harness/src/agent/local-models.mjs.

Per (instance, model) it renders the agent's real first request with the
model's chat template and counts tokens:
  lowerBound = system prompt + empty-repository context block + tools + issue prompt
  upperBound = lowerBound + the model's repository-context cap in characters
               (characters >= tokens for ASCII)
and classifies against the input budget contextLimit - maxOutputTokens - 5% margin:
  fits                  upperBound fits
  cannot_fit            lowerBound already exceeds  (certain)
  depends_on_context    in between; decided by the real repository context at run time
No instance is removed: infeasible instances stay in the denominator and are
reported separately (ADR 0009). Output: datasets/swe-bench-verified/context-feasibility-v1.json
"""
import collections
import json
import os
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]
HUB = pathlib.Path(os.getenv("KAB_HF_HUB", "/data/jackb/krasis/huggingface/hub"))
REQS = ROOT / ".cache/swebench/initial-requests"
OUT = ROOT / "datasets/swe-bench-verified/context-feasibility-v1.json"
# upstage-cli >= b17a1f3 with the harness's contextBudget (ADR 0010): input budget =
# contextLimit - maxOutputTokens - ceil(5% of contextLimit); repository context
# capped at floor(inputBudget * 0.09 * charsPerToken) characters.
SAFETY_MARGIN_RATIO = 0.05
PLACE = {"<<<KAB_REPO>>>": "repo", "<<<KAB_BASE_COMMIT>>>": "base_commit", "<<<KAB_ISSUE>>>": "problem_statement"}


def local_models():
    js = "import('./harness/src/agent/local-models.mjs').then(m => console.log(JSON.stringify(m.LOCAL_MODELS)))"
    return json.loads(subprocess.run(["node", "-e", js], cwd=ROOT, capture_output=True, text=True, check=True).stdout)


def snapshot(cfg):
    repo = cfg["provenance"]["hfRepo"].replace("/", "--")
    return HUB / f"models--{repo}" / "snapshots" / cfg["provenance"]["revision"]


def main():
    from transformers import AutoTokenizer
    os.environ["HF_HUB_OFFLINE"] = "1"
    models = local_models()
    subset = json.loads((ROOT / "datasets/swe-bench-verified/subset-v1.json").read_text())
    rows = {}
    for line in next((ROOT / ".cache/swebench").glob("*/instances.jsonl")).read_text().splitlines():
        r = json.loads(line)
        rows[r["instance_id"]] = r
    per_model, table = {}, collections.defaultdict(dict)
    for key, cfg in models.items():
        # Never execute repository code: the generic fast tokenizer from
        # tokenizer.json + the snapshot's chat template is what is counted.
        tok = AutoTokenizer.from_pretrained(snapshot(cfg), local_files_only=True, trust_remote_code=False)
        req = json.loads((REQS / f"{key}.json").read_text())
        kwargs = cfg.get("chatTemplateKwargs") or {}
        margin = -(-cfg["contextLimit"] * 5 // 100)
        budget = cfg["contextLimit"] - cfg["maxOutputTokens"] - margin
        repo_cap_chars = int(budget * 0.09 * cfg["contextCharsPerToken"])
        per_model[key] = {"contextLimit": cfg["contextLimit"], "maxOutputTokens": cfg["maxOutputTokens"], "inputBudget": budget,
                          "repositoryContextCapChars": repo_cap_chars,
                          "tokenizer": f"{cfg['provenance']['hfRepo']}@{cfg['provenance']['revision']}", "tokenizerClass": type(tok).__name__,
                          "chatTemplateKwargs": kwargs}
        for iid in subset["instance_ids"]:
            inst = rows[iid]
            msgs = []
            for m in req["messages"]:
                c = m["content"]
                for ph, field in PLACE.items():
                    c = c.replace(ph, inst[field])
                msgs.append({"role": m["role"], "content": c})
            ids = tok.apply_chat_template(msgs, tools=req.get("tools"), add_generation_prompt=True, tokenize=True, **kwargs)
            n = len(ids["input_ids"]) if isinstance(ids, dict) or hasattr(ids, "keys") else len(ids)
            upper = n + repo_cap_chars
            cls = "fits" if upper <= budget else ("cannot_fit" if n > budget else "depends_on_context")
            table[iid][key] = {"lowerBound": n, "upperBound": upper, "class": cls}
    summary = {k: dict(collections.Counter(table[i][k]["class"] for i in table)) for k in models}
    out = {
        "kind": "swebench-context-feasibility",
        "preregistered": "Recomputed 2026-10-29 after the context-budget fix (ADR 0010), before any model run on SWE-bench; classification never uses model output.",
        "subset": subset["subset"], "promptTemplateSha256": json.loads((REQS / "summary.json").read_text())["promptTemplateSha256"],
        "method": __doc__.split("Per (instance, model)")[1].split("No instance")[0].strip(),
        "contextBudget": "upstage-cli b17a1f3 + harness contextBudget (ADR 0010): the validated limit, output reservation and calibrated chars/token reach the agent loop; the per-model repository-context cap is listed under models.",
        "policy": "Instances are never removed for infeasibility. Results report resolved / unresolved / infeasible (context) / infrastructure error separately per model.",
        "models": per_model, "summary": summary, "instances": table,
    }
    OUT.write_text(json.dumps(out, indent=1) + "\n")
    print(json.dumps(summary, indent=1))
    for k in models:
        lows = sorted(table[i][k]["lowerBound"] for i in table)
        print(f"{k:15} lowerBound tokens min/median/max = {lows[0]}/{lows[len(lows)//2]}/{lows[-1]}  inputBudget={per_model[k]['inputBudget']}")


if __name__ == "__main__":
    main()
