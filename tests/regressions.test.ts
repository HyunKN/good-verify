import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fixture } from "./helpers.js";
import { redact } from "../src/core/redaction.js";
import { validateScenario } from "../src/core/model.js";
import { Store } from "../src/adapters/storage.js";
import {
  htmlReport,
  markdownReport,
  issueTemplate,
} from "../src/adapters/report.js";

it("serializes metadata reads with concurrent writes without losing entries", async () => {
  const f = await fixture();
  try {
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        Promise.all([
          f.workbench.work(f.project.id, { title: "Work " + i }),
          f.workbench.store.read(f.project.id),
        ]),
      ),
    );
    expect((await f.workbench.store.read(f.project.id)).workItems).toHaveLength(
      40,
    );
  } finally {
    await f.close();
  }
});

it("rejects unexecuted and duplicate expectations", () => {
  expect(() =>
    validateScenario(
      [],
      [
        {
          id: "a",
          kind: "manual",
          pageId: "page-1",
          expected: "Observe",
          afterStep: 1,
        },
      ],
    ),
  ).toThrow();
  expect(() =>
    validateScenario(
      [],
      [
        { id: "a", kind: "manual", pageId: "page-1", expected: "A" },
        { id: "a", kind: "manual", pageId: "page-1", expected: "B" },
      ],
    ),
  ).toThrow();
});
it("redacts structured credentials and entire cookie headers", () => {
  expect(redact("\u001b[31m실패\u001b[0m")).toBe("실패");
  expect(
    redact(
      JSON.stringify({
        password: "example-secret",
        cookie: "sid=private-example",
      }),
    ),
  ).not.toMatch(/example-secret|private-example/);
  expect(redact("Cookie: session=example1; refresh=example2")).not.toMatch(
    /example1|example2/,
  );
});
it("rejects preparation failures before opening a browser", async () => {
  const f = await fixture();
  try {
    await f.workbench.configure(f.project.id, {
      ...f.project,
      prepareCommandId: "fail",
    });
    await expect(f.workbench.startSession(f.project.id)).rejects.toThrow(
      "준비 실패",
    );
    const d = await f.workbench.snapshot(f.project.id);
    expect(d.sessions[0].status).toBe("incomplete");
    expect(f.workbench.recordings.size).toBe(0);
  } finally {
    await f.close();
  }
});
it("recovers append-before-metadata crash and truncated JSONL tail", async () => {
  const f = await fixture();
  try {
    const sid = randomUUID();
    await f.workbench.store.update(f.project.id, (d) => {
      d.sessions.push({
        id: sid,
        projectId: f.project.id,
        schemaVersion: 1,
        status: "recording",
        startedAt: "now",
        code: {
          revision: "x",
          dirty: false,
          fingerprint: "x",
          capturedAt: "now",
        },
        eventCount: 0,
        capture: { serverLogs: false, networkBodies: false },
        notes: [],
      });
    });
    await f.workbench.store.append(f.project.id, sid, {
      kind: "action",
      data: { type: "click" },
    });
    await f.workbench.store.update(f.project.id, (d) => {
      d.sessions[0].eventCount = 0;
    });
    await fs.appendFile(
      path.join(
        f.workbench.store.projectDir(f.project.id),
        "sessions",
        sid,
        "events.jsonl",
      ),
      '{"partial":',
    );
    await new Store(f.workbench.store.root).recover();
    const d = await f.workbench.snapshot(f.project.id);
    expect(d.sessions[0].status).toBe("incomplete");
    expect(d.sessions[0].eventCount).toBe(1);
    expect(await f.workbench.store.events(f.project.id, sid)).toHaveLength(1);
  } finally {
    await f.close();
  }
});
it("keeps canonical report decisions and redaction across formats", async () => {
  const f = await fixture();
  try {
    await f.workbench.work(f.project.id, {
      title: "<script>alert(1)</script>",
      requirement: "password=private-example",
      criteria: ["Observable result"],
    });
    const r = await f.workbench.report(f.project.id);
    expect(r.workItems[0].gate.complete).toBe(false);
    for (const output of [
      JSON.stringify(r),
      markdownReport(r),
      htmlReport(r),
      issueTemplate(r),
    ]) {
      expect(output).not.toContain("private-example");
    }
    expect(htmlReport(r)).not.toContain("<script>alert");
    expect(htmlReport(r)).toContain("&lt;script&gt;");
    const exported = await f.workbench.exportReport(f.project.id, {
      destination: path.join(f.dir, "export"),
    });
    expect((await fs.readdir(exported.folder)).sort()).toEqual([
      "evidence",
      "issue.md",
      "report.html",
      "report.json",
      "report.md",
    ]);
  } finally {
    await f.close();
  }
});
it("rejects unsupported metadata version without overwriting it", async () => {
  const f = await fixture();
  try {
    const file = path.join(
      f.workbench.store.projectDir(f.project.id),
      "project.json",
    );
    const d = JSON.parse(await fs.readFile(file, "utf8"));
    d.schemaVersion = 999;
    await fs.writeFile(file, JSON.stringify(d));
    await expect(f.workbench.store.read(f.project.id)).rejects.toThrow(
      "지원되지 않는",
    );
    expect(JSON.parse(await fs.readFile(file, "utf8")).schemaVersion).toBe(999);
    d.schemaVersion = 1;
    await fs.writeFile(file, JSON.stringify(d));
  } finally {
    await f.close();
  }
});
it("portable settings refuse machine paths and private file traversal", async () => {
  const f = await fixture();
  try {
    await expect(f.workbench.exportProject(f.project.id)).rejects.toThrow(
      "절대 경로",
    );
    await expect(
      f.workbench.configure(f.project.id, {
        ...f.project,
        files: { secret: "../private.txt" },
      }),
    ).rejects.toThrow();
    await f.workbench.configure(f.project.id, { ...f.project, commands: [] });
    expect((await f.workbench.exportProject(f.project.id)).root).toBe(".");
  } finally {
    await f.close();
  }
});
