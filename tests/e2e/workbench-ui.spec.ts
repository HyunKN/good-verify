import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createServer } from "node:net";
import { fixture } from "../helpers.js";
import { startSample } from "../../samples/editor/server.js";

test("built UI and source CLI start, connect, record, run and reopen existing data", async ({
  page,
}) => {
  const f = await fixture();
  await fs.writeFile(
    path.join(f.root, "package.json"),
    JSON.stringify({
      scripts: { test: 'node -e "process.exit(0)"', dev: "vite" },
      devDependencies: { vite: "8" },
    }),
  );
  const sample = await startSample(0);
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const dataDir = path.join(f.dir, "cli-data");
  let output = "";
  const launch = () => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/interfaces/cli.ts",
        "serve",
        "--headless",
        "--port",
        String(port),
        "--data-dir",
        dataDir,
      ],
      { cwd: process.cwd(), windowsHide: true, stdio: "pipe" },
    );
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (output += b));
    return child;
  };
  let service = launch();
  const waitReady = async () => {
    await expect
      .poll(
        async () => {
          try {
            return (await fetch(`http://127.0.0.1:${port}/health`)).status;
          } catch {
            return 0;
          }
        },
        { timeout: 20000, message: output },
      )
      .toBe(200);
  };
  try {
    await waitReady();
    await page.goto(`http://127.0.0.1:${port}`);
    await page
      .getByRole("button", { name: "프로젝트 연결", exact: false })
      .last()
      .click();
    await page.getByLabel("표시 이름").fill("Generic UI project");
    await page.getByLabel("프로젝트 폴더", { exact: true }).fill(f.root);
    await page.getByLabel("시작 URL").fill(sample.url);
    await page
      .getByRole("button", { name: "프로젝트 설정 찾기", exact: true })
      .click();
    await expect(page.getByRole("region", { name: "찾은 설정" })).toBeVisible();
    await expect(page.getByLabel("시작 URL")).toHaveValue(sample.url);
    await expect(page.getByLabel("검사 연결: npm run test")).not.toBeChecked();
    await page.getByLabel("검사 연결: npm run test").check();
    await page.screenshot({
      path: "test-results/project-suggestions.png",
      fullPage: true,
    });
    await page.getByText("기존 검사·준비 명령 연결", { exact: true }).click();
    await page.getByLabel("검사 명령 JSON").fill(
      JSON.stringify([
        {
          id: "check",
          label: "Generic check",
          program: process.execPath,
          args: ["-e", 'console.log("verified")'],
        },
      ]),
    );
    await page.getByRole("button", { name: "저장", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "작업과 완료 기준" }),
    ).toBeVisible();
    await expect(
      page.getByText("처음 사용하는 순서", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.screenshot({
      path: "test-results/first-use-guide.png",
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "QA 기록으로 이동", exact: true })
      .click();
    await expect(page.getByRole("button", { name: "● QA 시작" })).toBeVisible();
    await page.getByRole("button", { name: "01 작업과 완료 기준" }).click();
    await page
      .locator(".list-row")
      .filter({ hasText: "Generic check" })
      .getByRole("button", { name: "검사 실행 →" })
      .click();
    await page.getByRole("button", { name: "04 실행 결과" }).click();
    await expect(page.getByText("등록된 명령 종료 코드: 0")).toBeVisible();
    await page.getByRole("button", { name: "02 QA 기록" }).click();
    await page.getByRole("button", { name: "● QA 시작" }).click();
    await expect(
      page.getByRole("button", { name: "■ 기록 종료" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "■ 기록 종료" }).click();
    await expect(page.getByRole("button", { name: "● QA 시작" })).toBeVisible();
    const runtime = JSON.parse(
      await fs.readFile(path.join(dataDir, "runtime.json"), "utf8"),
    );
    const headers = { Authorization: `Bearer ${runtime.token}` };
    const { projects } = await (
      await fetch(runtime.url + "/api/v1/projects", { headers })
    ).json();
    const snapshot = await (
      await fetch(runtime.url + "/api/v1/projects/" + projects[0].id, {
        headers,
      })
    ).json();
    expect(
      snapshot.project.commands.some(
        (command: { program: string }) => command.program === "npm",
      ),
    ).toBe(true);
    const { events } = await (
      await fetch(
        runtime.url +
          "/api/v1/projects/" +
          projects[0].id +
          "/sessions/" +
          snapshot.sessions[0].id +
          "/events",
        { headers },
      )
    ).json();
    expect(
      events.filter((e: { kind: string }) => e.kind === "error"),
      "Recorder must also work under tsx, not only the test transpiler",
    ).toEqual([]);
    // Pause a real outgoing transition; the previous tree must remain mounted.
    await page.getByRole("button", { name: "05 보고서" }).evaluate((button) => {
      (button as HTMLButtonElement).click();
    });
    await expect(page.locator(".content")).toHaveAttribute(
      "data-phase",
      "exit",
    );
    await page.locator(".content").evaluate((element) => {
      for (const animation of element.getAnimations()) {
        animation.pause();
        animation.currentTime = 80;
      }
    });
    await expect(
      page.getByRole("heading", { name: "QA 기록", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".content")).toHaveAttribute("inert", "");
    await page.screenshot({ path: "test-results/workbench-transition.png" });
    // Newest destination wins, even when an outgoing animation is interrupted.
    await page.getByRole("button", { name: "03 검증 시나리오" }).click();
    await expect(
      page.getByRole("heading", { name: "검증 시나리오", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".content")).not.toHaveAttribute("data-phase");
    await expect(page.locator(".content")).not.toHaveAttribute("inert");
    await page
      .getByRole("button", { name: "프로젝트 설정", exact: true })
      .click();
    await expect(page.locator(".modal-backdrop")).not.toHaveAttribute(
      "data-phase",
    );
    await page.getByLabel("표시 이름").fill("Preserved during exit");
    await page.keyboard.press("Escape");
    await expect(page.locator(".modal-backdrop")).toHaveAttribute(
      "data-phase",
      "exit",
    );
    await page.locator(".modal-backdrop").evaluate((element) => {
      for (const animation of element.getAnimations({ subtree: true })) {
        animation.pause();
        animation.currentTime = 90;
      }
    });
    await expect(page.getByLabel("표시 이름")).toHaveValue(
      "Preserved during exit",
    );
    await expect(page.locator("main")).toHaveAttribute("inert", "");
    await page.screenshot({ path: "test-results/workbench-dialog-exit.png" });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "프로젝트 설정", exact: true }),
    ).toBeFocused();
    await page.getByRole("button", { name: "02 QA 기록" }).click();
    await expect(
      page.getByRole("heading", { name: "QA 기록", exact: true }),
    ).toBeVisible();
    expect(
      await page
        .locator(".content")
        .evaluate((el) => el.getAnimations().length),
    ).toBe(0);
    await page
      .getByRole("button", { name: "프로젝트 설정", exact: true })
      .click();
    await page.getByLabel("표시 이름").fill("Unsaved motion check");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "프로젝트 설정", exact: true }),
    ).toBeFocused();
    await page.screenshot({
      path: "test-results/workbench-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "test-results/workbench-mobile.png",
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.goto("about:blank");
    service.kill();
    await new Promise<void>((resolve) => service.once("exit", () => resolve()));
    service = launch();
    await waitReady();
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.locator("#project")).toContainText("Generic UI project");
  } finally {
    service.kill();
    await f.close();
    await sample.close();
  }
});
