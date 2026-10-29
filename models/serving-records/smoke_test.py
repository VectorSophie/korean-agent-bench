#!/usr/bin/env python3
"""Smoke-test harness for the isolated Korean-model vLLM servers (port 8101).

Pure stdlib (urllib) so nothing is installed. Runs, against an already-running
OpenAI-compatible endpoint:
  B  basic generation x2 (streaming, TTFT/throughput)
  C  structured tool-call + synthetic-result continuation (multi-turn)
  D  reasoning extraction (thinking models) with an ADEQUATE token budget,
     recording finish_reason / token counts / whether the reasoning sequence
     actually closed (</think>) so an *unfinished* sequence is never
     misreported as a broken parser
  R  reasoning + tool calling TOGETHER (thinking on): reasoning must not leak
     into tool_calls or the scored content
  E  resource/latency snapshot

  python3 smoke_test.py --model EXAONE-4.5 --reasoning qwen3 \
      --container kserve-exaone --devices 0 --out results/exaone.json \
      [--max-tokens 4096] [--thinking both|on|off]

Reasoning values: deepseek_r1 | qwen3 | none  (none => reasoning check = N/A).
It NEVER substitutes a parser or edits the output; it reports exactly what the
server returns and preserves the raw message for reproducibility.
"""
import argparse, json, os, re, subprocess, sys, time, urllib.request, urllib.error

THINK_TAG_RE = re.compile(r"</?think>")

def post(port, path, payload, stream=False, timeout=1200):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data,
                                 headers={"Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=timeout)

def get(port, path, timeout=30):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=timeout) as r:
        return json.loads(r.read())

def chat(port, payload):
    """Non-streaming chat; returns (message_dict, usage_dict, finish_reason, err)."""
    try:
        r = json.loads(post(port, "/v1/chat/completions", payload).read())
        ch = r["choices"][0]
        return ch.get("message", {}), r.get("usage", {}) or {}, ch.get("finish_reason"), None
    except urllib.error.HTTPError as e:
        return {}, {}, None, f"HTTP {e.code}: {e.read().decode(errors='replace')[:400]}"
    except Exception as e:
        return {}, {}, None, f"{type(e).__name__}: {e}"

def provider_reasoning_tokens(usage, reasoning_text):
    """Provider-reported reasoning TOKEN count (not chars). Returns null when
    unavailable or unreliable: some parsers (e.g. deepseek_r1 here) report 0
    even with thousands of reasoning chars because they count tokens strictly
    between a *generated* think-open/think-close, and the open tag is in the prompt.
    We never pass a known-wrong 0 off as a real token count."""
    d = usage.get("completion_tokens_details") or {}
    v = d.get("reasoning_tokens")
    if v is None:
        return None
    if v == 0 and reasoning_text and reasoning_text.strip():
        return None  # unreliable: reasoning text exists but counter says 0
    return v

def reasoning_of(message):
    """vLLM v0.32.0 puts extracted reasoning in `reasoning`; older/other builds
    use `reasoning_content`. Read whichever the server returns."""
    return message.get("reasoning") or message.get("reasoning_content") or ""

# ---- tools with two distinct schemas (check C / R) ----
TOOLS = [
 {"type": "function", "function": {
   "name": "get_current_weather",
   "description": "Get the current weather for a city.",
   "parameters": {"type": "object", "properties": {
       "city": {"type": "string", "description": "City name, e.g. Seoul"},
       "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}},
     "required": ["city"]}}},
 {"type": "function", "function": {
   "name": "convert_currency",
   "description": "Convert an amount from one currency to another.",
   "parameters": {"type": "object", "properties": {
       "amount": {"type": "number"},
       "from_currency": {"type": "string"},
       "to_currency": {"type": "string"}},
     "required": ["amount", "from_currency", "to_currency"]}}},
]

SAMPLING = {}  # vendor-recommended sampling (top_k/presence_penalty/...), merged into every request

def basic_gen(port, model, prompt, max_tokens):
    """Streaming gen; returns dict with ttft/throughput/finish_reason/text."""
    payload = {"model": model, "stream": True,
               "stream_options": {"include_usage": True}, "max_tokens": max_tokens,
               "messages": [{"role": "user", "content": prompt}], **SAMPLING}
    t0 = time.time(); ttft = None; text = []; ctoks = None; tfirst = None; finish = None
    try:
        resp = post(port, "/v1/chat/completions", payload, stream=True)
        for raw in resp:
            line = raw.decode(errors="replace").strip()
            if not line.startswith("data:"):
                continue
            chunk = line[5:].strip()
            if chunk == "[DONE]":
                break
            obj = json.loads(chunk)
            if obj.get("usage"):
                ctoks = obj["usage"].get("completion_tokens")
            for ch in obj.get("choices", []):
                # count visible content OR reasoning as "first token" for TTFT
                delta = ch.get("delta", {})
                piece = delta.get("content") or ""
                rpiece = delta.get("reasoning_content") or delta.get("reasoning") or ""
                if (piece or rpiece) and ttft is None:
                    ttft = time.time() - t0; tfirst = time.time()
                text.append(piece)
                if ch.get("finish_reason"):
                    finish = ch["finish_reason"]
        gen = (time.time() - (tfirst or t0))
        return {"ttft_s": round(ttft, 3) if ttft else None,
                "gen_s": round(gen, 3), "completion_tokens": ctoks,
                "tok_per_s": round(ctoks / gen, 1) if (ctoks and gen) else None,
                "finish_reason": finish, "ok": bool("".join(text).strip()),
                "snippet": "".join(text)[:200], "err": None}
    except urllib.error.HTTPError as e:
        return {"ok": False, "err": f"HTTP {e.code}: {e.read().decode(errors='replace')[:400]}"}
    except Exception as e:
        return {"ok": False, "err": f"{type(e).__name__}: {e}"}

def tool_call(port, model, max_tokens, enable_thinking=None):
    """Check C/R: turn 1 expects a tool_call; turn 2 feeds a synthetic result.
    With a thinking model + adequate budget, reasoning must NOT leak into
    tool_calls or the scored content."""
    out = {"max_tokens": max_tokens, "enable_thinking": enable_thinking,
           "turn1": {}, "turn2": {}, "error": None}
    extra = {}
    if enable_thinking is not None:
        extra["chat_template_kwargs"] = {"enable_thinking": enable_thinking}
    msgs = [{"role": "user", "content": "서울의 현재 날씨를 섭씨로 알려줘."}]
    p1 = {"model": model, "messages": msgs, "tools": TOOLS, "tool_choice": "auto",
          "max_tokens": max_tokens, "temperature": 0, **SAMPLING, **extra}
    m, usage, finish, err = chat(port, p1)
    if err:
        out["error"] = err; return out
    tcs = m.get("tool_calls") or []
    content = m.get("content") or ""
    rc = reasoning_of(m)
    out["turn1"] = {"finish_reason": finish, "has_tool_call": bool(tcs),
                    "reasoning_present": bool(rc), "reasoning_chars": len(rc),
                    "provider_reasoning_tokens": provider_reasoning_tokens(usage, rc),
                    "content_had_think_tag": bool(THINK_TAG_RE.search(content)),
                    "reasoning_leaked_as_content": bool(rc) and bool(content) and rc.strip() in content,
                    "completion_tokens": usage.get("completion_tokens")}
    if not tcs:
        out["error"] = f"no tool_calls (finish={finish}); content[:200]={content[:200]!r}"
        return out
    tc = tcs[0]; fn = tc["function"]
    out["turn1"]["selected_tool"] = fn["name"]
    try:
        args = json.loads(fn["arguments"]); out["turn1"]["args_valid_json"] = True
    except Exception as e:
        out["turn1"]["args_valid_json"] = False; out["error"] = f"bad args json: {e}"; return out
    # turn 2: synthetic tool result
    msgs.append({"role": "assistant", "content": m.get("content"), "tool_calls": tcs})
    msgs.append({"role": "tool", "tool_call_id": tc.get("id", "call_0"), "name": fn["name"],
                 "content": json.dumps({"city": args.get("city", "Seoul"), "temp_c": 7, "condition": "맑음"})})
    p2 = {"model": model, "messages": msgs, "tools": TOOLS, "max_tokens": max_tokens,
          "temperature": 0, **SAMPLING, **extra}
    m2, usage2, finish2, err2 = chat(port, p2)
    if err2:
        out["error"] = err2; return out
    final = m2.get("content") or ""
    out["turn2"] = {"finish_reason": finish2, "final_snippet": final[:300],
                    "uses_result": ("7" in final) or ("맑" in final),
                    "content_had_think_tag": bool(THINK_TAG_RE.search(final)),
                    "reasoning_present": bool(reasoning_of(m2))}
    out["ok"] = bool(out["turn1"].get("args_valid_json") and out["turn2"].get("uses_result"))
    return out

def reasoning_check(port, model, reasoning, max_tokens, enable_thinking=None):
    """Thinking question with an ADEQUATE budget. Distinguishes a finished vs
    truncated reasoning sequence so truncation is never called a parser bug."""
    if reasoning in ("none", "", None):
        return {"applicable": False, "note": "non-thinking model; N/A"}
    extra = {}
    if enable_thinking is not None:
        extra["chat_template_kwargs"] = {"enable_thinking": enable_thinking}
    # A question that genuinely requires multi-step reasoning.
    q = ("한 농부가 닭과 토끼를 키운다. 머리는 모두 35개, 다리는 모두 94개다. "
         "닭과 토끼는 각각 몇 마리인가? 단계적으로 풀어줘.")
    payload = {"model": model, "temperature": 0.6, "top_p": 0.95, "max_tokens": max_tokens,
               "messages": [{"role": "user", "content": q}], **SAMPLING, **extra}
    m, usage, finish, err = chat(port, payload)
    if err:
        return {"applicable": True, "enable_thinking": enable_thinking, "error": err}
    rc = reasoning_of(m)
    content = m.get("content") or ""
    reasoning_finished = (finish == "stop") and bool(content.strip())
    return {"applicable": True, "enable_thinking": enable_thinking,
            "finish_reason": finish,
            "prompt_tokens": usage.get("prompt_tokens"),
            "completion_tokens": usage.get("completion_tokens"),
            "provider_reasoning_tokens": provider_reasoning_tokens(usage, rc),  # null if unreliable/absent
            "reasoning_chars": len(rc),  # CHARACTERS, not tokens
            "reasoning_extracted": bool(rc.strip()),
            "content_present": bool(content.strip()),
            "content_len": len(content),
            "reasoning_finished": reasoning_finished,
            "think_tag_in_content": bool(THINK_TAG_RE.search(content)),
            "think_tag_in_reasoning": bool(THINK_TAG_RE.search(rc)),
            "answer_has_digits": bool(re.search(r"\d", content)),  # expect 23 닭 / 12 토끼
            "reasoning_snippet": rc[:200],
            "answer_snippet": content[:220]}

def resources(container, devices):
    r = {"gpu": [], "container_mem": None, "note": "instantaneous (not guaranteed peak)"}
    for d in devices.split(","):
        try:
            o = subprocess.check_output(["nvidia-smi", "-i", d,
                 "--query-gpu=memory.used,memory.total,utilization.gpu",
                 "--format=csv,noheader,nounits"], text=True).strip()
            used, total, util = [x.strip() for x in o.split(",")]
            r["gpu"].append({"index": d, "mem_used_mib": int(used),
                             "mem_total_mib": int(total), "util_pct": int(util)})
        except Exception as e:
            r["gpu"].append({"index": d, "error": str(e)})
    try:
        o = subprocess.check_output(["docker", "stats", "--no-stream", "--format",
             "{{.MemUsage}}", container], text=True).strip()
        r["container_mem"] = o
    except Exception as e:
        r["container_mem"] = f"err: {e}"
    return r

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--port", type=int, default=8101)
    ap.add_argument("--reasoning", default="none")
    ap.add_argument("--container", required=True)
    ap.add_argument("--devices", default="0")
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-tokens", type=int, default=4096,
                    help="output budget for tool/reasoning checks (thinking models need >=4096)")
    ap.add_argument("--thinking", choices=["both", "on", "off"], default="on",
                    help="EXAONE: test enable_thinking on, off, or both; 'on' = vendor default")
    ap.add_argument("--sampling", default="{}",
                    help='JSON of vendor sampling merged into every request, '
                         'e.g. \'{"top_k":20,"presence_penalty":1.5}\'')
    a = ap.parse_args()
    global SAMPLING
    SAMPLING = json.loads(a.sampling)
    res = {"model": a.model, "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "max_tokens": a.max_tokens, "reasoning_parser": a.reasoning}

    try:
        res["served_models"] = [m["id"] for m in get(a.port, "/v1/models")["data"]]
    except Exception as e:
        res["served_models"] = f"ERR {e}"

    # B: basic generation x2 (adequate budget so thinking models finish)
    res["basic"] = []
    for p in ["대한민국의 수도는 어디이며, 그 도시의 명소 세 곳을 알려주세요.",
              "인공지능 안전성 연구가 중요한 이유를 두 문장으로 설명해줘."]:
        b = basic_gen(a.port, a.model, p, a.max_tokens)
        b["prompt"] = p[:40]
        res["basic"].append(b)

    thinking_variants = {"both": [True, False], "on": [None], "off": [False]}[a.thinking]
    # 'on' uses None => server/template vendor default (which is thinking-on for both models)

    # C/R: tool calling (multi-turn) + reasoning-no-leak, per thinking variant
    res["tool"] = [tool_call(a.port, a.model, a.max_tokens, et) for et in thinking_variants]
    # D: reasoning extraction, per thinking variant
    res["reasoning"] = [reasoning_check(a.port, a.model, a.reasoning, a.max_tokens, et)
                        for et in thinking_variants]
    # E: resources
    res["resources"] = resources(a.container, a.devices)

    # readiness rollup
    b_ok = all(x.get("ok") for x in res["basic"])
    tool_ok = any(t.get("ok") for t in res["tool"])
    # reasoning_ok: for thinking models, at least one variant finished AND separated
    rr = [r for r in res["reasoning"] if r.get("applicable")]
    reasoning_ok = (not rr) or any(
        r.get("reasoning_finished") and r.get("reasoning_extracted")
        and r.get("content_present") and not r.get("think_tag_in_content")
        for r in rr if r.get("enable_thinking") in (None, True))
    res["rollup"] = {"inference_ready": b_ok, "tool_ready": tool_ok,
                     "reasoning_separation_ok": reasoning_ok}

    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    json.dump(res, open(a.out, "w"), ensure_ascii=False, indent=2)
    print(json.dumps(res["rollup"]), "->", a.out)
    print("  basic:", [(x.get("ok"), x.get("finish_reason"), x.get("tok_per_s")) for x in res["basic"]])
    for t in res["tool"]:
        print(f"  tool(enable_thinking={t.get('enable_thinking')}): ok={t.get('ok')} "
              f"turn1={ {k:t['turn1'].get(k) for k in ('has_tool_call','selected_tool','args_valid_json','reasoning_present','content_had_think_tag')} } "
              f"turn2_uses_result={t.get('turn2',{}).get('uses_result')} err={t.get('error')}")
    for r in res["reasoning"]:
        if r.get("applicable"):
            print(f"  reason(enable_thinking={r.get('enable_thinking')}): finish={r.get('finish_reason')} "
                  f"reasoning_extracted={r.get('reasoning_extracted')}({r.get('reasoning_chars')} chars) "
                  f"content={r.get('content_present')}({r.get('content_len')} chars) "
                  f"finished={r.get('reasoning_finished')} think_tag_in_content={r.get('think_tag_in_content')} "
                  f"provider_reasoning_tokens={r.get('provider_reasoning_tokens')}")
        else:
            print("  reason: N/A (non-thinking)")

if __name__ == "__main__":
    sys.exit(main())
