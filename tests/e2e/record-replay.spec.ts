import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startSample } from "../../samples/editor/server.js";
import { fixture } from "../helpers.js";
test("human QA recording: bug fails, fix passes, review gates and offline export", async ({
  browser,
}) => {
  const sample = await startSample(0);
  const f = await fixture(sample.url);
  try {
    const w = await f.workbench.work(f.project.id, {
      title: "Cancel editing",
      requirement: "Cancel keeps the original title",
      criteria: ["Saved title remains unchanged"],
    });
    const session = await f.workbench.startSession(f.project.id, w.id);
    const page = f.workbench.recordings.get(session.id)!.pages.get("page-1")!;
    await expect(page.getByRole("button", { name: "문제 표시" })).toBeVisible();
    await page.getByLabel("제목", { exact: true }).fill("수정한 제목");
    await page.getByRole("button", { name: "취소", exact: true }).click();
    await f.workbench.finding(f.project.id, {
      sessionId: session.id,
      workItemId: w.id,
      title: "Cancel saves changes",
      expected: "처음 제목",
      actual: "수정한 제목",
    });
    await f.workbench.stopSession(f.project.id, session.id);
    const draft = await f.workbench.draft(f.project.id, {
      sessionId: session.id,
      name: "Cancel preserves original",
      workItemId: w.id,
      assertions: [
        {
          id: "saved",
          kind: "text",
          locator: { kind: "testId", value: "saved-title" },
          expected: "처음 제목",
        },
      ],
    });
    expect(
      draft.steps.some((s) => s.type === "fill" && s.value === "수정한 제목"),
    ).toBe(true);
    await f.workbench.startRun(f.project.id, {
      kind: "scenario",
      targetId: draft.id,
      workItemId: w.id,
    });
    await f.workbench.idle();
    let d = await f.workbench.snapshot(f.project.id);
    expect(d.runs[0].status, d.runs[0].detail).toBe("failed");
    sample.setFixed(true);
    await fs.writeFile(path.join(f.root, "source.txt"), "cancel fix");
    await f.workbench.startRun(f.project.id, {
      kind: "scenario",
      targetId: draft.id,
      workItemId: w.id,
    });
    await f.workbench.idle();
    d = await f.workbench.snapshot(f.project.id);
    const run = d.runs[1];
    expect(run.status, run.detail).toBe("passed");
    await f.workbench.register(f.project.id, draft.id, {
      reviewer: "Sample reviewer",
      runId: run.id,
    });
    await f.workbench.work(
      f.project.id,
      { ...w, requiredScenarioIds: [draft.id] },
      w.id,
    );
    await f.workbench.updateFinding(f.project.id, d.findings[0].id, {
      resolutionRunId: run.id,
      confirmedCause: "Cancel handler persisted the draft.",
    });
    await f.workbench.review(f.project.id, w.id, {
      reviewer: "Sample reviewer",
      verdict: "approved",
      evidence: "Compared cancel handler and replay results",
    });
    d = await f.workbench.snapshot(f.project.id);
    expect(d.gates[w.id].complete).toBe(true);
    expect(d.runs[0].status).toBe("failed");
    const output = await f.workbench.exportReport(f.project.id, {
      destination: path.join(f.dir, "exports"),
      evidenceIds: run.evidenceIds,
    });
    const report = JSON.parse(
      await fs.readFile(path.join(output.folder, "report.json"), "utf8"),
    );
    expect(JSON.stringify(report)).not.toContain(
      f.root.replaceAll("\\", "\\\\"),
    );
    const offline = await browser.newContext({ offline: true });
    const reportPage = await offline.newPage();
    await reportPage.goto(
      pathToFileURL(path.join(output.folder, "report.html")).href,
    );
    await expect(
      reportPage.getByRole("heading", { name: "결론", exact: true }),
    ).toBeVisible();
    await expect(
      reportPage.getByText("검증 완료", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        reportPage
          .locator("img")
          .evaluateAll((images) =>
            images.every(
              (image) => (image as HTMLImageElement).naturalWidth > 0,
            ),
          ),
      )
      .toBe(true);
    await reportPage.screenshot({
      path: "test-results/offline-report.png",
      fullPage: true,
    });
    await offline.close();
    const source = await f.workbench.testSource(f.project.id, draft.id);
    expect(source).toContain("@playwright/test");
    expect(source).not.toContain("good-verify");
  } finally {
    await f.close();
    await sample.close();
  }
});
test("IME, rapid clicks, select, checkbox, navigation and unsupported canvas are preserved", async () => {
  const sample = await startSample(0);
  const f = await fixture(sample.url);
  try {
    const s = await f.workbench.startSession(f.project.id);
    const page = f.workbench.recordings.get(s.id)!.pages.get("page-1")!;
    const input = page.getByLabel("제목", { exact: true });
    await input.focus();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", {
      text: "한글",
      selectionStart: 2,
      selectionEnd: 2,
    });
    await cdp.send("Input.insertText", { text: "한글" });
    await page.getByRole("button", { name: "횟수 추가" }).dblclick();
    await page.getByLabel("공개").check();
    await page.getByLabel("분류").focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.getByLabel("비밀번호").fill("never-export-this-secret");
    await page.locator("canvas").click();
    await page.getByRole("link", { name: "다음 화면", exact: true }).click();
    await f.workbench.stopSession(f.project.id, s.id);
    const events = await f.workbench.store.events(f.project.id, s.id);
    const text = JSON.stringify(events);
    expect(text).toContain("한글");
    expect(text).not.toContain("never-export-this-secret");
    expect(events.some((e) => e.data.type === "manual")).toBe(true);
    expect(events.some((e) => e.data.type === "check")).toBe(true);
    expect(events.some((e) => e.data.type === "select")).toBe(true);
    const draft = await f.workbench.draft(f.project.id, {
      sessionId: s.id,
      name: "Interactions",
    });
    expect(draft.steps.some((s) => s.detail === "double")).toBe(true);
    await f.workbench.startRun(f.project.id, {
      kind: "scenario",
      targetId: draft.id,
    });
    await f.workbench.idle();
    const run = (await f.workbench.snapshot(f.project.id)).runs[0];
    expect(run.status, run.detail).toBe("manual-required");
  } finally {
    await f.close();
    await sample.close();
  }
});
