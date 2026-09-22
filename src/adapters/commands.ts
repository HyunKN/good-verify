import spawn from "cross-spawn";
import { execFile } from "node:child_process";
import type { Project } from "../core/model.js";
import { redact } from "../core/redaction.js";
export function runCommand(
  project: Project,
  id: string,
  signal: AbortSignal,
  onOutput: (text: string) => void,
): Promise<number> {
  const command = project.commands.find((c) => c.id === id);
  if (!command) throw new Error("등록되지 않은 검사입니다.");
  return new Promise((resolve, reject) => {
    const child = spawn(command.program, command.args, {
      cwd: project.root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let timedOut = false;
    let done = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = () => {
      if (done || !child.pid) return;
      if (process.platform === "win32")
        execFile(
          "taskkill",
          ["/pid", String(child.pid), "/t", "/f"],
          { windowsHide: true },
          () => {},
        );
      else {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill();
        }
        if (!escalation)
          escalation = setTimeout(() => {
            if (done || !child.pid) return;
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }, 1000);
      }
    };
    signal.addEventListener("abort", kill, { once: true });
    if (signal.aborted) kill();
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, command.timeoutMs);
    let output = "";
    const receive = (chunk: Buffer) => {
      output += chunk.toString();
      const lines = output.split("\n");
      output = lines.pop() || "";
      for (const line of lines) onOutput(redact(line) + "\n");
      if (output.length > 32768) {
        onOutput("[긴 출력 줄 생략]\n");
        output = "";
      }
    };
    child.stdout?.on("data", receive);
    child.stderr?.on("data", receive);
    child.on("error", (error) => {
      done = true;
      clearTimeout(timer);
      clearTimeout(escalation);
      signal.removeEventListener("abort", kill);
      reject(error);
    });
    child.on("close", (code) => {
      done = true;
      clearTimeout(timer);
      clearTimeout(escalation);
      signal.removeEventListener("abort", kill);
      if (output) onOutput(redact(output));
      if (timedOut) reject(new Error("명령 실행 시간이 초과되었습니다."));
      else if (signal.aborted) reject(new Error("실행 취소"));
      else resolve(code ?? 1);
    });
  });
}
