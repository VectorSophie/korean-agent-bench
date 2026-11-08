// Queue-held serving session (models/serving/kserve-session.sh). No GPU, no
// container, no queue: fake `docker`, `nvidia-smi` and `curl` come first on
// PATH. The REAL launchers (kserve.sh, kserve-solar.sh) run unchanged behind
// the session; the fakes record every docker call and keep a container list.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getLocalModelConfig } from "../src/agent/local-models.mjs";

const SESSION = resolve(fileURLToPath(import.meta.url), "../../../models/serving/kserve-session.sh");
const SOLAR_IMG = getLocalModelConfig("solar-open2").provenance.servingImage;

function fakes({ healthy = true, existing = "" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "h35-"));
  const state = join(dir, "containers");
  const log = join(dir, "docker.log");
  writeFileSync(state, existing ? existing + "\n" : "");
  const bin = (name, body) => { writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(dir, name), 0o755); };
  bin("docker", `echo "$*" >> "${log}"
case "$1" in
  ps) cat "${state}";;
  run) n=""; prev=""; for a in "$@"; do [ "$prev" = --name ] && n=$a; prev=$a; done; echo "$n" >> "${state}"; echo cid;;
  stop|rm) n=\${@: -1}; grep -vx "$n" "${state}" > "${state}.t"; mv "${state}.t" "${state}";;
  image) echo "${SOLAR_IMG}";;
  logs) echo fake-logs;;
esac
exit 0`);
  bin("nvidia-smi", "echo 0");
  bin("curl", healthy ? `grep -q kserve- "${state}"` : "exit 7");
  bin("sleep", `exec /bin/sleep 0.05`); // the launcher's 10 s wait ticks
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, KSERVE_SESSION_DIR: join(dir, "session"), KSERVE_SESSION_POLL: "0.1" };
  const containers = () => readFileSync(state, "utf8").split("\n").filter(Boolean);
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
  return { dir, env, containers, calls, session: join(dir, "session") };
}

const runSync = (f, args, extra = {}) => spawnSync("bash", [SESSION, ...args], { env: { ...f.env, ...extra }, encoding: "utf8", timeout: 30000 });
const runFor = (f, args, extra, untilFn) => new Promise((resolveP) => {
  const p = spawn("bash", [SESSION, ...args], { env: { ...f.env, ...extra } });
  let out = "";
  p.stdout.on("data", (c) => { out += c; if (untilFn) { const go = untilFn(out); if (go) { untilFn = null; go(p); } } });
  p.stderr.on("data", (c) => (out += c));
  p.on("close", (code, signal) => resolveP({ code, signal, out }));
});
const healthyThen = (act) => (out) => (/healthy on GPU/.test(out) ? act : null);

describe("kserve-session: queue-held model server lifecycle (fakes only)", () => {
  it("refuses outside a queue allocation, before any docker call", () => {
    const f = fakes();
    for (const cvd of [undefined, "", "-1"]) {
      const env = { ...f.env };
      if (cvd === undefined) delete env.CUDA_VISIBLE_DEVICES; else env.CUDA_VISIBLE_DEVICES = cvd;
      const r = spawnSync("bash", [SESSION, "kanana"], { env, encoding: "utf8" });
      assert.equal(r.status, 3);
      assert.match(r.stdout, /not inside a GPU-queue allocation/);
    }
    assert.deepEqual(f.calls(), []);
  });

  it("refuses a GPU count that does not match the model's tensor parallelism", () => {
    const f = fakes();
    assert.equal(runSync(f, ["ax"], { CUDA_VISIBLE_DEVICES: "0" }).status, 3);
    assert.equal(runSync(f, ["kanana"], { CUDA_VISIBLE_DEVICES: "0,1" }).status, 3);
    assert.equal(runSync(f, ["solar"], { CUDA_VISIBLE_DEVICES: "1" }).status, 3);
    assert.deepEqual(f.calls(), []);
  });

  it("refuses to adopt an existing kserve container (the launcher alone would)", () => {
    const f = fakes({ existing: "kserve-kanana" });
    const r = runSync(f, ["kanana"], { CUDA_VISIBLE_DEVICES: "1" });
    assert.equal(r.status, 3);
    assert.match(r.stdout, /already exist: kserve-kanana/);
    assert.ok(!f.calls().some((c) => c.startsWith("run")), "nothing started");
    assert.deepEqual(f.containers(), ["kserve-kanana"], "and nothing stopped");
  });

  it("serves on exactly the queue's GPUs and stops the container on release", async () => {
    const f = fakes();
    const r = await runFor(f, ["kanana", "16384"], { CUDA_VISIBLE_DEVICES: "1" },
      healthyThen(() => writeFileSync(join(f.session, "release"), "")));
    assert.equal(r.code, 0, r.out);
    const run = f.calls().find((c) => c.startsWith("run"));
    assert.match(run, /NVIDIA_VISIBLE_DEVICES=1 /, "the queue's GPU, not the launcher default");
    assert.match(run, /--max-model-len 16384/);
    assert.ok(f.calls().some((c) => c === "stop -t 30 kserve-kanana"));
    assert.deepEqual(f.containers(), []);
    assert.equal(existsSync(join(f.session, "kanana.json")), false);
  });

  it("SIGTERM (queue kill) stops the container", async () => {
    const f = fakes();
    const r = await runFor(f, ["ax"], { CUDA_VISIBLE_DEVICES: "0,1" }, healthyThen((p) => p.kill("SIGTERM")));
    assert.ok(r.code === 143 || r.signal === "SIGTERM", r.out);
    assert.match(f.calls().find((c) => c.startsWith("run")), /NVIDIA_VISIBLE_DEVICES=0,1 /);
    assert.deepEqual(f.containers(), []);
  });

  it("the lease ends the session and stops the server", async () => {
    const f = fakes();
    const r = await runFor(f, ["exaone"], { CUDA_VISIBLE_DEVICES: "0", KSERVE_LEASE_SEC: "1" });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /lease of 1s over/);
    assert.deepEqual(f.containers(), []);
  });

  it("a server that dies ends the session with status 1", async () => {
    const f = fakes();
    const r = await runFor(f, ["kanana"], { CUDA_VISIBLE_DEVICES: "0" },
      healthyThen(() => writeFileSync(join(f.dir, "containers"), "")));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /kserve-kanana exited/);
  });

  it("a server that never becomes healthy is stopped (status 1)", async () => {
    const f = fakes({ healthy: false });
    const r = await runFor(f, ["kanana"], { CUDA_VISIBLE_DEVICES: "0" });
    assert.equal(r.code, 1, r.out);
    assert.deepEqual(f.containers(), []);
  });

  it("Solar runs through its own launcher with the pinned image on the queue's GPUs", async () => {
    const f = fakes();
    const r = await runFor(f, ["solar"], { CUDA_VISIBLE_DEVICES: "0,1", KSERVE_MIN_FREE_MIB: "0" },
      healthyThen(() => writeFileSync(join(f.session, "release"), "")));
    assert.equal(r.code, 0, r.out);
    const run = f.calls().find((c) => c.startsWith("run"));
    assert.ok(run.includes(SOLAR_IMG));
    assert.match(run, /NVIDIA_VISIBLE_DEVICES=0,1 /);
    assert.deepEqual(f.containers(), []);
  });
});
