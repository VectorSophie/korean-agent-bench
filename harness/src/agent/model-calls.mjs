// Per-call model accounting shared by every agent harness (trace.modelCalls,
// kab.model-call/v1). Three different counts, never conflated:
//   logical call      one model call the harness's own loop makes (upstage-cli:
//                     LocalOpenAIAdapter.complete(); mini: DefaultAgent →
//                     model.query()). One record each.
//   transport attempt one HTTP request to /chat/completions; a client's own
//                     retries make several per logical call (transportAttempts,
//                     null when not observable).
//   tool action       one command/tool executed in the sandbox (trace.toolCalls);
//                     a record's firstToolCall/toolCallsExecuted is its slice.
// Token counts are the provider's own usage fields, or null (never 0 for unknown).
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

export const MODEL_CALL_SCHEMA = "kab.model-call/v1";

const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const obj = (v) => (v && typeof v === "object" ? v : null);

export function newCallRecord(index) {
  return {
    index, outcome: null, error: null, startedAt: null, durationMs: null, transportAttempts: null,
    promptTokens: null, completionTokens: null, totalTokens: null, reasoningTokens: null, reasoningChars: null,
    finishReason: null, toolCallsRequested: null, firstToolCall: null, toolCallsExecuted: 0
  };
}

/** The record fields a provider's raw chat-completions body determines. */
export function fromResponseBody(body) {
  const b = obj(body) ?? {};
  const u = obj(b.usage) ?? {};
  const details = obj(u.completion_tokens_details) ?? {};
  const choice = obj(Array.isArray(b.choices) ? b.choices[0] : null);
  const msg = obj(choice?.message) ?? {};
  const rt = msg.reasoning_content ?? msg.reasoning;
  return {
    promptTokens: count(u.prompt_tokens), completionTokens: count(u.completion_tokens), totalTokens: count(u.total_tokens),
    reasoningTokens: count(details.reasoning_tokens), reasoningChars: typeof rt === "string" && rt.length ? rt.length : null,
    finishReason: choice?.finish_reason ?? null,
    toolCallsRequested: choice ? (Array.isArray(msg.tool_calls) ? msg.tool_calls.length : 0) : null
  };
}

/** Run totals from per-call records. Over the calls that returned a response
 *  (a call that failed without one, e.g. a context-length rejection, has no
 *  usage and is counted in failedCalls), each total is the exact sum of the
 *  provider-reported values, or null when any of them lacks the value. */
export function aggregateUsage(calls) {
  const answered = calls.filter((c) => c.outcome !== "error");
  const sum = (list, k) => (list.every((c) => Number.isInteger(c[k])) ? list.reduce((s, c) => s + c[k], 0) : null);
  return {
    promptTokens: sum(answered, "promptTokens"), completionTokens: sum(answered, "completionTokens"),
    totalTokens: sum(answered, "totalTokens"), reasoningTokens: sum(answered, "reasoningTokens"),
    modelCalls: calls.length, failedCalls: calls.length - answered.length,
    transportAttempts: sum(calls, "transportAttempts")
  };
}

/** Assigns trace.toolCalls slices to records from the event order: each
 *  tool_start belongs to the latest call that began before it. `eventsBefore`
 *  (per record) is the number of loop events yielded when the call began. */
export function assignToolCalls(calls, eventsBefore, events) {
  let tool = 0;
  events.forEach((e, pos) => {
    if (e?.type !== "tool_start") return;
    let k = -1;
    for (let i = 0; i < calls.length; i++) if (eventsBefore[i] <= pos) k = i;
    if (k >= 0) {
      calls[k].toolCallsExecuted += 1;
      calls[k].firstToolCall ??= tool;
    }
    tool += 1;
  });
  return calls;
}

// ── upstage-cli: observation of the model adapter KAB constructs ───────────
// Transport attempts are counted by a pass-through wrapper on globalThis.fetch
// (the adapter calls the global fetch for every attempt, retries included),
// attributed through AsyncLocalStorage to the logical call that issued them, so
// concurrent runs cannot be confused. Outside an observed call it does nothing.
const als = new AsyncLocalStorage();
let observedFetch = null;

function ensureFetchObserver() {
  if (observedFetch && globalThis.fetch === observedFetch) return true;
  if (observedFetch) return false; // someone replaced fetch after us: attempts are not observable
  const original = globalThis.fetch;
  observedFetch = function kabObservedFetch(input, init) {
    const state = als.getStore();
    const pending = original(input, init);
    if (!state || !state.matches(input)) return pending;
    state.attempts += 1;
    state.body = null;
    return pending.then((res) => {
      // The provider's own body for the record; the original stream is untouched.
      if (!/event-stream/.test(res.headers.get("content-type") ?? "")) state.body = res.clone().json().catch(() => null);
      return res;
    });
  };
  globalThis.fetch = observedFetch;
  return true;
}

/**
 * Wraps one LocalOpenAIAdapter instance (pass-through: same arguments, same
 * return value, same exceptions) and returns the records it produces plus a
 * pass-through for the loop's event generator.
 */
export function observeOpenAIAdapter(adapter) {
  const calls = [];
  const eventsBefore = [];
  let yielded = 0;
  const endpoint = `${adapter.baseUrl}/chat/completions`;
  const urlOf = (input) => (typeof input === "string" ? input : input?.url ?? String(input));
  const complete = adapter.complete;
  adapter.complete = async function observedComplete(...args) {
    const rec = newCallRecord(calls.length);
    calls.push(rec);
    eventsBefore.push(yielded);
    const observable = ensureFetchObserver();
    const state = { attempts: 0, body: null, matches: (input) => urlOf(input) === endpoint };
    rec.startedAt = Date.now();
    const t0 = performance.now();
    try {
      const result = await als.run(state, () => complete.apply(adapter, args));
      rec.outcome = "response";
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // a response arrived but was unusable (empty turn, malformed tool call)
      rec.outcome = /\[protocol\]/.test(message) ? "format_error" : "error";
      rec.error = message.slice(0, 500);
      throw e;
    } finally {
      rec.durationMs = Math.round(performance.now() - t0);
      rec.transportAttempts = observable ? state.attempts : null;
      const body = state.body ? await state.body : null;
      if (body) Object.assign(rec, fromResponseBody(body));
    }
  };
  return {
    calls,
    tapEvents(gen) {
      return {
        next: (...a) => gen.next(...a).then((r) => { if (!r.done) yielded += 1; return r; }),
        return: (...a) => gen.return(...a),
        throw: (...a) => gen.throw(...a),
        [Symbol.asyncIterator]() { return this; }
      };
    },
    finish(events) { return assignToolCalls(calls, eventsBefore, events); }
  };
}
