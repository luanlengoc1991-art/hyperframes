// A production pipeline whose state lives in <project>/pipeline.json. Each stage records its
// inputs' hash, status, attempts and a small output summary, so a re-run skips finished
// stages with unchanged inputs and resumes at the first stage that failed or was blocked.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A stage that cannot run on this machine yet (missing tool, missing credential, needs approval). */
export class BlockedError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "BlockedError";
  }
}

export function hashOf(value) {
  return createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

export class Pipeline {
  constructor(projectDir) {
    this.dir = projectDir;
    this.file = join(projectDir, "pipeline.json");
    mkdirSync(projectDir, { recursive: true });
    this.state = existsSync(this.file)
      ? JSON.parse(readFileSync(this.file, "utf8"))
      : { version: 1, createdAt: new Date().toISOString(), stages: {} };
  }

  save() {
    this.state.updatedAt = new Date().toISOString();
    writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }

  /**
   * Run `fn` as stage `name` unless it already finished with the same inputs.
   * Returns { status, output, skipped }. A BlockedError marks the stage blocked and does not throw;
   * any other error is retried up to `retries` times, then marks the stage failed and throws.
   */
  async stage(name, inputs, fn, { retries = 1 } = {}) {
    const inputHash = hashOf(inputs);
    const prev = this.state.stages[name];
    if (prev?.status === "done" && prev.inputHash === inputHash) {
      return { status: "done", output: prev.output, skipped: true };
    }
    const record = {
      status: "running",
      inputHash,
      attempts: 0,
      startedAt: new Date().toISOString(),
    };
    this.state.stages[name] = record;
    for (;;) {
      record.attempts += 1;
      this.save();
      try {
        const output = await fn();
        Object.assign(record, {
          status: "done",
          output,
          error: null,
          finishedAt: new Date().toISOString(),
        });
        this.save();
        return { status: "done", output, skipped: false };
      } catch (error) {
        if (error instanceof BlockedError) {
          Object.assign(record, {
            status: "blocked",
            error: error.message,
            finishedAt: new Date().toISOString(),
          });
          this.save();
          return { status: "blocked", output: null, skipped: false };
        }
        if (record.attempts <= retries) continue;
        Object.assign(record, {
          status: "failed",
          error: String(error?.message || error),
          finishedAt: new Date().toISOString(),
        });
        this.save();
        throw error;
      }
    }
  }
}
