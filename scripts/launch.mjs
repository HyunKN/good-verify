import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";

const root = fileURLToPath(new URL("../", import.meta.url));
const update = process.argv.includes("--update");
const portArg = process.argv.find((value) => value.startsWith("--port="));
const port = Number(portArg?.slice(7) || 4318);
function run(program, args, capture = false) {
  const result = spawnSync(program, args, {
    cwd: root,
    stdio: capture ? "pipe" : "inherit",
    encoding: "utf8",
    windowsHide: true,
    // Only fixed internal npm arguments reach cmd; no project/page input.
    shell: process.platform === "win32" && program === "npx",
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${program} 단계 실패. 위 오류를 확인한 뒤 다시 실행하세요. 파일은 자동 삭제하지 않습니다.`,
    );
  return result.stdout?.trim();
}
try {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("포트는 1024~65535 사이의 정수여야 합니다.");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 14))
    throw new Error(
      "Node.js 22.14 이상이 필요합니다. https://nodejs.org/ 에서 설치한 뒤 다시 실행하세요.",
    );
  if (process.argv.includes("--check-only")) {
    console.log("Node.js 확인 완료. 실행 위치:", root);
  } else {
    if (!update && !process.argv.includes("--prepare-only")) {
      const url = `http://127.0.0.1:${port}`;
      const response = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(1500),
      }).catch(() => undefined);
      if (response) {
        const health = await response.json().catch(() => ({}));
        if (health.product !== "good-verify" || health.status !== "ok")
          throw new Error(
            `${port} 포트를 다른 서비스가 사용 중입니다. --port=다른번호 로 실행하세요.`,
          );
        if (process.env.GV_DATA_DIR)
          throw new Error(
            "선택한 포트에서 서비스가 실행 중입니다. 별도 데이터 공간은 다른 포트로 실행하세요.",
          );
        console.log(`이미 실행 중인 good-verify를 엽니다: ${url}`);
        if (!process.argv.includes("--no-open")) {
          if (process.platform === "win32")
            run("cmd.exe", ["/d", "/c", "start", "", url]);
          else run(process.platform === "darwin" ? "open" : "xdg-open", [url]);
        }
        process.exit(0);
      }
    }
    if (update) {
      if (run("git", ["status", "--porcelain"], true))
        throw new Error(
          "로컬 변경이 있어 업데이트를 중단했습니다. 수정 파일을 커밋하거나 별도 보관한 뒤 다시 실행하세요. 자동 덮어쓰기/초기화는 하지 않습니다.",
        );
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(1500),
        });
        if (response.ok) throw new Error("RUNNING");
      } catch (error) {
        if (error.message === "RUNNING")
          throw new Error(
            "실행 중인 good-verify 창에서 Ctrl+C로 종료한 뒤 업데이트하세요.",
          );
      }
      console.log(
        "업데이트: 현재 브랜치의 upstream을 fast-forward로만 반영합니다.",
      );
      run("git", ["pull", "--ff-only"]);
    }
    const manifest = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    );
    if (!/^pnpm@\d+\.\d+\.\d+$/.test(manifest.packageManager))
      throw new Error("packageManager에는 고정된 pnpm 버전이 필요합니다.");
    const pnpm = (args) =>
      run("npx", ["--yes", manifest.packageManager, ...args]);
    console.log(
      "1/3 고정된 버전으로 실행 환경 준비 (최초 실행에는 인터넷이 필요합니다)",
    );
    pnpm(["install", "--frozen-lockfile"]);
    console.log("2/3 QA 브라우저 준비");
    pnpm(["browser:install"]);
    console.log("3/3 화면 빌드");
    pnpm(["build"]);
    if (update)
      console.log(
        "업데이트 완료. start.cmd를 실행하세요. 기존 QA 데이터는 저장소 밖에 그대로 유지됩니다.",
      );
    else if (!process.argv.includes("--prepare-only")) {
      console.log("이 창을 유지하세요. 종료하려면 Ctrl+C를 누르세요.");
      run(process.execPath, [
        "--import",
        "tsx",
        "src/interfaces/cli.ts",
        "serve",
        "--port",
        String(port),
        ...(process.argv.includes("--no-open") ? [] : ["--open"]),
      ]);
    }
  }
} catch (error) {
  console.error("\n실행하지 못했습니다:", error.message);
  process.exitCode = 1;
}
