import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { startSample } from "../../samples/editor/server.js";
import { fixture } from "../helpers.js";

test("fresh contexts, private preparation and portable generated test", async () => {
  const sample = await startSample(0);
  sample.setFixed(true);
  const f = await fixture(sample.url);
  try {
    const s = await f.workbench.startSession(f.project.id);
    const page = f.workbench.recordings.get(s.id)!.pages.get("page-1")!;
    await page.getByLabel("제목", { exact: true }).fill("보존한 제목");
    await page.getByRole("button", { name: "저장", exact: true }).click();
    await f.workbench.stopSession(f.project.id, s.id);
    const scenario = await f.workbench.draft(f.project.id, {
      sessionId: s.id,
      name: "Save title",
      assertions: [
        {
          id: "saved",
          kind: "text",
          locator: { kind: "testId", value: "saved-title" },
          expected: "보존한 제목",
        },
      ],
    });
    const s2 = await f.workbench.startSession(f.project.id);
    const page2 = f.workbench.recordings.get(s2.id)!.pages.get("page-1")!;
    await expect(page2.getByTestId("saved-title")).toHaveText("처음 제목");
    await page2.getByLabel("제목", { exact: true }).fill("준비 상태");
    await page2.getByRole("button", { name: "저장", exact: true }).click();
    await page2
      .context()
      .addCookies([
        { name: "auth", value: "private-cookie-value", url: sample.url },
      ]);
    await f.workbench.saveBrowserState(f.project.id, s2.id);
    await f.workbench.stopSession(f.project.id, s2.id);
    const s3 = await f.workbench.startSession(f.project.id);
    await expect(
      f.workbench.recordings
        .get(s3.id)!
        .pages.get("page-1")!
        .getByTestId("saved-title"),
    ).toHaveText("준비 상태");
    await f.workbench.stopSession(f.project.id, s3.id);
    const report = await f.workbench.exportReport(f.project.id, {
      destination: path.join(f.dir, "export"),
    });
    for (const file of ["report.json", "report.md", "report.html", "issue.md"])
      expect(
        await fs.readFile(path.join(report.folder, file), "utf8"),
      ).not.toContain("private-cookie-value");
    const standalone = path.join(f.dir, "standalone");
    await fs.mkdir(standalone);
    await fs.symlink(
      path.resolve("node_modules"),
      path.join(standalone, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await fs.writeFile(
      path.join(standalone, "portable.spec.ts"),
      await f.workbench.testSource(f.project.id, scenario.id),
    );
    await fs.writeFile(
      path.join(standalone, "playwright.config.ts"),
      `export default { testDir: '.', workers: 1, reporter: 'line', use: {headless:true} };`,
    );
    const result = await new Promise<{ code: number | null; output: string }>(
      (resolve, reject) => {
        let output = "";
        const child = spawn(
          process.execPath,
          [path.resolve("node_modules/@playwright/test/cli.js"), "test"],
          {
            cwd: standalone,
            env: { ...process.env, BASE_URL: sample.url },
            windowsHide: true,
          },
        );
        child.stdout.on("data", (b) => (output += b));
        child.stderr.on("data", (b) => (output += b));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, output }));
      },
    );
    expect(result.code, result.output).toBe(0);
    await f.workbench.startRun(f.project.id, {
      kind: "scenario",
      targetId: scenario.id,
    });
    await f.workbench.idle();
    await f.workbench.updateScenario(f.project.id, scenario.id, {
      ...scenario,
      steps: [],
      assertions: [],
    });
    const run = (await f.workbench.snapshot(f.project.id)).runs[0];
    expect(run.scenarioSnapshot?.steps.length).toBeGreaterThan(0);
    expect(run.scenarioVersion).toBe(1);
  } finally {
    await f.close();
    await sample.close();
  }
});
test("ambiguous locator cannot pass and abnormal browser close is incomplete", async () => {
  const sample = await startSample(0);
  const f = await fixture(sample.url);
  try {
    const s = await f.workbench.startSession(f.project.id);
    await f.workbench.recordings.get(s.id)!.browser.close();
    await expect
      .poll(
        async () =>
          (await f.workbench.snapshot(f.project.id)).sessions[0].status,
      )
      .toBe("incomplete");
    const scenario = await f.workbench.draft(f.project.id, {
      sessionId: s.id,
      name: "Incomplete",
    });
    expect(scenario.steps.some((s) => s.type === "manual")).toBe(true);
    await f.workbench.updateScenario(f.project.id, scenario.id, {
      name: "Ambiguous",
      prerequisites: "",
      steps: [
        {
          type: "click",
          pageId: "page-1",
          locator: { kind: "css", value: "button" },
        },
      ],
      assertions: [
        {
          id: "a",
          kind: "visible",
          pageId: "page-1",
          locator: { kind: "testId", value: "saved-title" },
          expected: "",
        },
      ],
    });
    await f.workbench.startRun(f.project.id, {
      kind: "scenario",
      targetId: scenario.id,
    });
    await f.workbench.idle();
    const r = (await f.workbench.snapshot(f.project.id)).runs[0];
    expect(r.status, r.detail).toBe("blocked");
  } finally {
    await f.close();
    await sample.close();
  }
});
