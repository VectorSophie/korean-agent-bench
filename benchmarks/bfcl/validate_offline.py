#!/usr/bin/env python3
"""Offline validation of the BFCL official pipeline. No model, no GPU.

    .cache/venv-bfcl/bin/python benchmarks/bfcl/validate_offline.py [--out DIR]

For a fixed slice of datasets/bfcl/subset-v1.json it:
  1. builds a plan from BFCL's own ground truth;
  2. serves it from fake_server.py on a free loopback port;
  3. runs the OFFICIAL `bfcl generate --run-ids` (OpenAICompletionsHandler, FC)
     and `bfcl evaluate --partial-eval` through kab_bfcl.py, under a mock
     registration (kab-offline-mock-FC), twice: mode gold and mode invalid;
  4. checks the official per-category scores (gold = 1.0, invalid = 0.0), the
     request contract seen by the server, and that only subset ids were run.
Writes result/score files, request logs and summary.json to --out.
These numbers validate the pipeline; they are NOT model scores.
"""
import argparse
import ast
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
HERE = ROOT / "benchmarks/bfcl"
PY = sys.executable
MOCK = "kab-offline-mock-FC"
SERVED = "kab-offline-mock"
SLICE = {  # entries per category taken from the head of the subset id list
    "simple_python": 3, "simple_java": 1, "simple_javascript": 1, "multiple": 2, "parallel": 2,
    "parallel_multiple": 2, "irrelevance": 2, "live_simple": 2, "live_multiple": 2,
    "live_irrelevance": 2, "live_relevance": 1, "multi_turn_base": 2,
}


def data_dir():
    import bfcl_eval
    return pathlib.Path(bfcl_eval.__file__).parent / "data"


def jsonl(path):
    return {e["id"]: e for e in (json.loads(l) for l in path.read_text().splitlines() if l.strip())}


OMIT = object()


def choose(acceptable):
    # Ground truth lists the acceptable values of an argument; "" = may be omitted.
    # A dict candidate is itself a mapping of key -> acceptable values (recursive).
    v = acceptable[0] if isinstance(acceptable, list) and acceptable else acceptable
    if v == "":
        return OMIT
    if isinstance(v, dict):
        return {k: c for k, c in ((k, choose(vals)) for k, vals in v.items()) if c is not OMIT}
    return v


def literal(v):
    # Java/JavaScript entries take arguments as language-literal strings.
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, str):
        return v
    return json.dumps(v) if isinstance(v, (list, dict)) else str(v)


def gold_args(params, as_literals=False):
    out = {}
    for k, values in params.items():
        v = choose(values)
        if v is not OMIT:
            out[k] = literal(v) if as_literals else v
    return out


def func_param_order(involved_classes):
    from bfcl_eval.constants.executable_backend_config import MULTI_TURN_FUNC_DOC_FILE_MAPPING
    order = {}
    for cls in involved_classes:
        doc = data_dir() / "multi_turn_func_doc" / MULTI_TURN_FUNC_DOC_FILE_MAPPING[cls]
        for line in doc.read_text().splitlines():
            if line.strip():
                d = json.loads(line)
                order[d["name"]] = list(d["parameters"]["properties"])
    return order


def parse_call(src, order):
    # Ground-truth multi-turn calls may use positional args; FC calls are named.
    node = ast.parse(src, mode="eval").body
    name = node.func.id if isinstance(node.func, ast.Name) else ast.unparse(node.func)
    args = {order[name][i]: ast.literal_eval(a) for i, a in enumerate(node.args)}
    args.update({kw.arg: ast.literal_eval(kw.value) for kw in node.keywords})
    return {"name": name, "args": args}


def first_user(question):
    turn0 = question[0]
    for m in turn0:
        if m.get("role") == "user":
            return m["content"]
    raise ValueError("no user message in first turn")


def build_plan(ids_by_cat, mode):
    d = data_dir()
    entries = {}
    for cat, ids in ids_by_cat.items():
        data = jsonl(d / f"BFCL_v4_{cat}.json")
        ans_path = d / "possible_answer" / f"BFCL_v4_{cat}.json"
        answers = jsonl(ans_path) if ans_path.exists() else {}
        for i in ids:
            e = data[i]
            key = first_user(e["question"])
            assert key not in entries, f"ambiguous plan key for {i}"
            if cat.startswith("multi_turn"):
                order = func_param_order(e["involved_classes"])
                turns = [[parse_call(c, order) for c in turn] for turn in answers[i]["ground_truth"]]
                entries[key] = {"id": i, "kind": "multi", "turns": turns}
            elif i in answers:
                lit = cat in ("simple_java", "simple_javascript")
                calls = [{"name": n.replace(".", "_"), "args": gold_args(a, lit)} for gt in answers[i]["ground_truth"] for n, a in gt.items()]
                entries[key] = {"id": i, "kind": "single", "calls": calls}
            elif cat == "live_relevance":  # correct behaviour: call some function
                fn = e["function"][0]["name"].replace(".", "_")
                entries[key] = {"id": i, "kind": "relevance", "calls": [{"name": fn, "args": {}}]}
            else:  # irrelevance: correct behaviour is not to call
                entries[key] = {"id": i, "kind": "single", "calls": []}
    return {"mode": mode, "servedModelName": SERVED, "entries": entries}


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def run_mode(mode, ids_by_cat, out):
    proj = out / mode
    if proj.exists():
        shutil.rmtree(proj)
    proj.mkdir(parents=True)
    (proj / "plan.json").write_text(json.dumps(build_plan(ids_by_cat, mode), indent=1))
    (proj / "test_case_ids_to_generate.json").write_text(json.dumps(ids_by_cat, indent=1))
    extra = proj / "extra-models.json"
    port = free_port()
    extra.write_text(json.dumps({MOCK: {"agent": "offline-mock", "servedModelName": SERVED, "baseUrlEnv": ["KAB_MOCK_BASE_URL"],
                                        "defaultBaseUrl": f"http://127.0.0.1:{port}/v1", "chatTemplateKwargs": None}}))
    log = proj / "requests.jsonl"
    srv = subprocess.Popen([PY, str(HERE / "fake_server.py"), str(proj / "plan.json"), str(port), str(log)],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        for _ in range(50):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/v1/models", timeout=1)
                break
            except OSError:
                time.sleep(0.1)
        env = {**os.environ, "BFCL_PROJECT_ROOT": str(proj), "KAB_BFCL_EXTRA_MODELS": str(extra)}
        env.pop("KAB_MOCK_BASE_URL", None)
        cats = ",".join(ids_by_cat)
        gen = subprocess.run([PY, str(HERE / "kab_bfcl.py"), "generate", "--model", MOCK, "--run-ids", "--num-threads", "1", "--include-input-log"],
                             env=env, capture_output=True, text=True)
        (proj / "generate.log").write_text(gen.stdout + gen.stderr)
        if gen.returncode != 0:
            raise SystemExit(f"[{mode}] bfcl generate failed ({gen.returncode}); see {proj / 'generate.log'}")
        ev = subprocess.run([PY, str(HERE / "kab_bfcl.py"), "evaluate", "--model", MOCK, "--test-category", cats, "--partial-eval"],
                            env=env, capture_output=True, text=True)
        (proj / "evaluate.log").write_text(ev.stdout + ev.stderr)
        if ev.returncode != 0:
            raise SystemExit(f"[{mode}] bfcl evaluate failed ({ev.returncode}); see {proj / 'evaluate.log'}")
    finally:
        srv.terminate()
        srv.wait(timeout=10)
    return proj


def read_scores(proj):
    scores = {}
    for f in sorted((proj / "score").rglob("*_score.json")):
        head = json.loads(f.read_text().splitlines()[0])
        cat = f.name.replace("BFCL_v4_", "").replace("_score.json", "")
        scores[cat] = {"accuracy": head.get("accuracy"), "correct": head.get("correct_count"), "total": head.get("total_count")}
    return scores


def generated_ids(proj):
    ids = set()
    for f in (proj / "result").rglob("*_result.json"):
        ids |= {json.loads(l)["id"] for l in f.read_text().splitlines() if l.strip()}
    return ids


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / ".cache/bfcl-offline-validation"))
    out = pathlib.Path(ap.parse_args().out).resolve()
    subset = json.loads((ROOT / "datasets/bfcl/subset-v1.json").read_text())
    ids_by_cat = {c: subset["categories"][c]["ids"][:n] for c, n in SLICE.items()}
    subset_ids = {i for c in subset["categories"].values() for i in c["ids"]}

    summary = {"kind": "bfcl-offline-validation", "note": "Pipeline validation with a deterministic mock; NOT model scores.",
               "bfclEval": __import__("importlib.metadata").metadata.version("bfcl-eval"), "slice": ids_by_cat, "modes": {}}
    failures = []
    for mode, expect in (("gold", 1.0), ("invalid", 0.0)):
        proj = run_mode(mode, ids_by_cat, out)
        scores = read_scores(proj)
        gen = generated_ids(proj)
        reqs = [json.loads(l) for l in (proj / "requests.jsonl").read_text().splitlines()]
        contract = {
            "requests": len(reqs),
            "models": sorted({r.get("model") for r in reqs}),
            "temperatures": sorted({r.get("temperature") for r in reqs}),
            "allHaveTools": all(bool(r.get("tools")) for r in reqs),
            "toolNamesWithDots": sum("." in t["function"]["name"] for r in reqs for t in r.get("tools", [])),
        }
        summary["modes"][mode] = {"expectedAccuracy": expect, "scores": scores, "generatedIds": len(gen), "requestContract": contract}
        if set(scores) != set(ids_by_cat):
            failures.append(f"{mode}: scored categories {sorted(scores)} != {sorted(ids_by_cat)}")
        for cat, s in scores.items():
            if s["accuracy"] != expect or s["total"] != len(ids_by_cat[cat]):
                failures.append(f"{mode}/{cat}: accuracy {s['accuracy']} total {s['total']} (expected {expect}, {len(ids_by_cat[cat])})")
        if gen != {i for ids in ids_by_cat.values() for i in ids} or not gen <= subset_ids:
            failures.append(f"{mode}: generated ids differ from the requested subset slice")
        if contract["models"] != [SERVED] or contract["toolNamesWithDots"]:
            failures.append(f"{mode}: request contract {contract}")
    summary["passed"] = not failures
    summary["failures"] = failures
    (out / "summary.json").write_text(json.dumps(summary, indent=1) + "\n")
    print(json.dumps({m: {c: v["accuracy"] for c, v in d["scores"].items()} for m, d in summary["modes"].items()}, indent=1))
    print("contract:", {m: d["requestContract"] for m, d in summary["modes"].items()})
    if failures:
        print("FAIL:\n  " + "\n  ".join(failures))
        sys.exit(1)
    print(f"bfcl offline validation: PASS ({out})")


if __name__ == "__main__":
    main()
