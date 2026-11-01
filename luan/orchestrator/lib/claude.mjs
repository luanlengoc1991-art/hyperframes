// Claude in local mode: the Claude Code binary already signed in on this machine, run headless.
// Usage is billed to that account's plan; nothing here holds an API key.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BlockedError } from "./pipeline.mjs";
import { findTool, firstJsonObject } from "./proc.mjs";

export function findClaude() {
  const onPath = findTool("claude");
  if (onPath) return onPath;
  const found = [];
  for (const ext of [".vscode", ".cursor", ".windsurf"]) {
    const base = join(homedir(), ext, "extensions");
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base).filter((n) => n.startsWith("anthropic.claude-code-"))) {
      const p = join(
        base,
        d,
        "resources",
        "native-binary",
        process.platform === "win32" ? "claude.exe" : "claude",
      );
      if (existsSync(p)) found.push({ p, m: statSync(p).mtimeMs });
    }
  }
  return found.sort((a, b) => b.m - a.m)[0]?.p ?? null;
}

/**
 * Run Claude Code once. `prompt` is the instruction, `input` (optional) is piped on stdin as
 * context. With `stream`, every assistant text / tool call is passed to `onEvent` as it happens.
 * Resolves { text, session, cost }.
 */
export function runClaude(
  prompt,
  {
    cwd,
    input = "",
    tools = [],
    addDirs = [],
    resume = null,
    onEvent = () => {},
    timeoutMs = 15 * 60_000,
    permission = "acceptEdits",
  } = {},
) {
  return new Promise((resolve, reject) => {
    const bin = findClaude();
    if (!bin) return reject(new BlockedError("Không tìm thấy Claude Code trên máy"));
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      permission,
    ];
    if (tools.length) args.push("--allowedTools", ...tools);
    else
      args.push(
        "--disallowedTools",
        "Bash",
        "Edit",
        "Write",
        "Read",
        "Glob",
        "Grep",
        "WebFetch",
        "WebSearch",
        "Task",
      );
    for (const d of addDirs) args.push("--add-dir", d);
    if (resume) args.push("--resume", resume);
    const p = spawn(bin, args, { cwd, windowsHide: true });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    let buf = "";
    let session = resume;
    let text = "";
    let cost = null;
    let failed = null;
    p.stdout.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const m = line ? firstJsonObject(line) : null;
        if (!m) continue;
        if (m.session_id) session = m.session_id;
        if (m.type === "system" && m.subtype === "thinking_tokens")
          onEvent({ kind: "thinking", tokens: m.estimated_tokens || 0 });
        if (m.type === "assistant")
          for (const c2 of m.message?.content || []) {
            if (c2.type === "text" && c2.text.trim()) onEvent({ kind: "text", text: c2.text });
            if (c2.type === "tool_use")
              onEvent({
                kind: "tool",
                name: c2.name,
                text: String(
                  c2.input?.description ||
                    c2.input?.command ||
                    c2.input?.file_path ||
                    c2.input?.pattern ||
                    "",
                ).slice(0, 200),
              });
          }
        if (m.type === "result") {
          text = m.result || "";
          cost = m.total_cost_usd ?? null;
          if (m.is_error) failed = m.result || m.subtype || "lỗi";
        }
      }
    });
    let err = "";
    p.stderr.on("data", (c) => (err += c));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && !failed) resolve({ text, session, cost });
      else reject(new Error(`Claude dừng (${code}): ${String(failed || err).slice(-400)}`));
    });
    p.stdin.end(input);
  });
}
