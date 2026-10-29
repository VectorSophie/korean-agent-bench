#!/usr/bin/env python3
"""Offline (CPU-only) regression test for the Kanana/EXAONE reasoning parsers.

Proves — deterministically, with NO GPU and NO model weights — that vLLM's
`deepseek_r1` (Kanana) and `qwen3` (EXAONE) reasoning parsers correctly
separate reasoning from content for these checkpoints' chat templates, which
inject the opening `<think>` into the PROMPT (so the model generates only the
reasoning body + closing `</think>` + answer).

It also pins the one true failure mode: when generation is TRUNCATED before
`</think>` (an unrealistically small max_tokens), the whole output is
(correctly) returned as reasoning_content with content=None. That is an
unfinished reasoning sequence, NOT a broken/incompatible parser.

Run inside the pinned serving image (tokenizers come from the read-only HF
cache; -I so the untrusted cache dir can't shadow stdlib imports):

  IMG=vllm/vllm-openai@sha256:6ee133356d49ed24cee03dd0cda3d3980279a11c107ce3e752c89e76540f41c9
  docker run --rm --entrypoint python3 \
    -v /data/jackb/krasis/huggingface/hub:/hf:ro \
    -v "$PWD":/sp:ro "$IMG" -I /sp/parser_regression_test.py

Exit code 0 = all assertions passed.
"""
from transformers import AutoTokenizer
from vllm.reasoning import ReasoningParserManager

K = "/hf/models--kakaocorp--kanana-2-30b-a3b-thinking-2601/snapshots/cdcbf8b811c21366f20f8a10a1f83183433c0844"
E = "/hf/models--LGAI-EXAONE--EXAONE-4.5-33B-FP8/snapshots/69570ad5d9a5159816ef267f2f4d37e36447f1be"

# Generated text: the prompt already supplied "<think>\n", so real model output
# has NO leading <think> — it is reasoning body, then </think>, then the answer.
COMPLETE    = "먼저 생각해보자. 서울은 한국의 수도다.</think>서울은 대한민국의 수도입니다."
TRUNCATED   = "먼저 생각해보자. 서울은 한국의 수도이고 인구는"          # budget died before </think>
WITH_START  = "<think>먼저 생각.</think>최종 답변."                     # model DID emit <think>
EMPTY_THINK = "</think>바로 답변합니다."                                # immediate answer

def mk(name, path, **kw):
    tok = AutoTokenizer.from_pretrained(path, trust_remote_code=True)
    cls = ReasoningParserManager.get_reasoning_parser(name)
    try:
        return cls(tok, **kw)
    except TypeError:
        return cls(tok)

def extract(parser, out):
    return parser.extract_reasoning(out, None)

def check(label, got, want):
    ok = got == want
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}: got={got!r}")
    if not ok:
        print(f"         expected={want!r}")
    return ok

def main():
    ok = True
    print("deepseek_r1 (Kanana tokenizer)")
    p = mk("deepseek_r1", K)
    ok &= check("complete -> split reasoning|content", extract(p, COMPLETE),
                ("먼저 생각해보자. 서울은 한국의 수도다.", "서울은 대한민국의 수도입니다."))
    ok &= check("truncated -> all reasoning, content None (UNFINISHED, not broken)",
                extract(p, TRUNCATED), ("먼저 생각해보자. 서울은 한국의 수도이고 인구는", None))
    ok &= check("leading <think> stripped + split", extract(p, WITH_START),
                ("먼저 생각.", "최종 답변."))
    ok &= check("immediate </think> -> empty reasoning + answer", extract(p, EMPTY_THINK),
                ("", "바로 답변합니다."))

    print("qwen3 (EXAONE tokenizer), thinking=default(on)")
    q = mk("qwen3", E)
    ok &= check("complete -> split reasoning|content", extract(q, COMPLETE),
                ("먼저 생각해보자. 서울은 한국의 수도다.", "서울은 대한민국의 수도입니다."))
    ok &= check("truncated -> all reasoning, content None (UNFINISHED, not broken)",
                extract(q, TRUNCATED), ("먼저 생각해보자. 서울은 한국의 수도이고 인구는", None))
    ok &= check("leading <think> stripped + split", extract(q, WITH_START),
                ("먼저 생각.", "최종 답변."))

    print("qwen3 (EXAONE tokenizer), enable_thinking=False")
    q0 = mk("qwen3", E, chat_template_kwargs={"enable_thinking": False})
    ok &= check("thinking off -> all content, no reasoning", extract(q0, "서울은 대한민국의 수도입니다."),
                (None, "서울은 대한민국의 수도입니다."))

    print("\nRESULT:", "ALL PASS" if ok else "FAILURES PRESENT")
    return 0 if ok else 1

if __name__ == "__main__":
    import sys
    sys.exit(main())
