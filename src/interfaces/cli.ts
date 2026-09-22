import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { defaultDataDir } from "../adapters/storage.js";
import { createServer } from "./server.js";
const args = process.argv.slice(2);
const command = args[0] || "serve";
const flag = (name: string) => {
  const i = args.indexOf("--" + name);
  return i < 0 ? undefined : args[i + 1];
};
const dataDir = path.resolve(
  flag("data-dir") || process.env.GV_DATA_DIR || defaultDataDir(),
);
async function main() {
  if (command === "serve") {
    const repo = fileURLToPath(new URL("../../", import.meta.url));
    const rel = path.relative(repo, dataDir);
    if (!rel.startsWith("..") && !path.isAbsolute(rel))
      throw new Error("데이터 디렉터리는 제품 저장소 밖이어야 합니다.");
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const lock = path.join(dataDir, "service.lock");
    try {
      await fs.writeFile(lock, String(process.pid), {
        flag: "wx",
        mode: 0o600,
      });
    } catch {
      let alive = false;
      try {
        const pid = Number(await fs.readFile(lock, "utf8"));
        if (Number.isInteger(pid) && pid > 0) {
          process.kill(pid, 0);
          alive = true;
        }
      } catch {}
      if (alive)
        throw new Error("같은 데이터 공간의 서비스가 이미 실행 중입니다.");
      await fs.unlink(lock);
      await fs.writeFile(lock, String(process.pid), {
        flag: "wx",
        mode: 0o600,
      });
    }
    const port = Number(flag("port") || 4318);
    let app: Awaited<ReturnType<typeof createServer>>["app"] | undefined;
    try {
      const server = await createServer({
        dataDir,
        port,
        headless: args.includes("--headless"),
        dev: args.includes("--dev"),
      });
      app = server.app;
      const url = await app.listen({ host: "127.0.0.1", port });
      await fs.writeFile(
        path.join(dataDir, "runtime.json"),
        JSON.stringify({ url, token: server.token }),
        { mode: 0o600 },
      );
      console.log(
        `good-verify: ${args.includes("--dev") ? "http://127.0.0.1:5173" : url}\n데이터는 제품 저장소 밖에 저장됩니다.`,
      );
      if (args.includes("--open")) {
        const browser =
          process.platform === "win32"
            ? spawn("cmd.exe", ["/d", "/c", "start", "", url], {
                windowsHide: true,
                stdio: "ignore",
              })
            : spawn(
                process.platform === "darwin" ? "open" : "xdg-open",
                [url],
                { stdio: "ignore" },
              );
        browser.on("error", () =>
          console.error(`브라우저에서 ${url} 을 직접 여세요.`),
        );
      }
      let closing = false;
      const close = async () => {
        if (closing) return;
        closing = true;
        await app?.close();
        await fs.unlink(lock).catch(() => {});
        await fs.unlink(path.join(dataDir, "runtime.json")).catch(() => {});
        process.exit(0);
      };
      process.on("SIGINT", () => void close());
      process.on("SIGTERM", () => void close());
    } catch (e) {
      await app?.close();
      await fs.unlink(lock).catch(() => {});
      throw e;
    }
    return;
  }
  if (command === "help") {
    console.log(
      "gv serve | projects | connect <config.json> | status --project ID | run --project ID (--scenario ID | --check ID) [--work ID] | report --project ID [--format markdown|json|issue]",
    );
    return;
  }
  const runtime = JSON.parse(
    await fs.readFile(path.join(dataDir, "runtime.json"), "utf8"),
  ) as { url: string; token: string };
  const request = async (route: string, body?: unknown) => {
    const r = await fetch(runtime.url + "/api/v1" + route, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${runtime.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(await r.text());
    return r;
  };
  if (command === "projects") {
    console.log(
      JSON.stringify(await (await request("/projects")).json(), null, 2),
    );
    return;
  }
  if (command === "connect") {
    const file = path.resolve(args[1]);
    const config = JSON.parse(await fs.readFile(file, "utf8"));
    config.root = path.resolve(path.dirname(file), config.root || ".");
    console.log(
      JSON.stringify(
        await (await request("/projects", config)).json(),
        null,
        2,
      ),
    );
    return;
  }
  const id = flag("project");
  if (!id) throw new Error("--project ID가 필요합니다.");
  if (command === "status")
    console.log(
      JSON.stringify(await (await request("/projects/" + id)).json(), null, 2),
    );
  else if (command === "run") {
    const scenario = flag("scenario"),
      check = flag("check");
    if (!scenario && !check)
      throw new Error("--scenario 또는 --check가 필요합니다.");
    console.log(
      JSON.stringify(
        await (
          await request(`/projects/${id}/runs`, {
            kind: scenario ? "scenario" : "command",
            targetId: scenario || check,
            workItemId: flag("work"),
          })
        ).json(),
        null,
        2,
      ),
    );
  } else if (command === "report")
    console.log(
      await (
        await request(
          `/projects/${id}/report?format=${encodeURIComponent(flag("format") || "markdown")}`,
        )
      ).text(),
    );
  else throw new Error("알 수 없는 명령입니다. pnpm gv help를 확인하세요.");
}
main().catch((e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
