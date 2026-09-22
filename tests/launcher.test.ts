import { test, expect } from "vitest";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

test("launcher reuses a running app without reinstalling and rejects port conflicts", async () => {
  let product = "good-verify";
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ product, status: "ok" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const args = ["scripts/launch.mjs", `--port=${port}`, "--no-open"];
  const env = { ...process.env };
  delete env.GV_DATA_DIR;
  try {
    const result = await exec(process.execPath, args, {
      env,
      windowsHide: true,
    });
    expect(result.stdout).toContain("이미 실행 중인 good-verify");
    expect(result.stdout).not.toContain("1/3");
    await expect(
      exec(process.execPath, args, {
        env: { ...env, GV_DATA_DIR: "separate-data" },
        windowsHide: true,
      }),
    ).rejects.toThrow("별도 데이터 공간");
    product = "other-service";
    await expect(
      exec(process.execPath, args, { env, windowsHide: true }),
    ).rejects.toThrow("다른 서비스");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
