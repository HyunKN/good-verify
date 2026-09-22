import { describe, it, expect } from "vitest";
import {
  completionGate,
  type ProjectData,
  type WorkItem,
} from "../src/core/model.js";
import { redact, safeUrl, actionUrl } from "../src/core/redaction.js";
const code = {
  revision: "abc",
  dirty: false,
  fingerprint: "current",
  capturedAt: "now",
};
function data() {
  const item: WorkItem = {
    id: "work",
    projectId: "project",
    title: "Save",
    requirement: "Persist input",
    criteria: ["Value survives reload"],
    version: 1,
    requiredCommandIds: ["check"],
    requiredScenarioIds: [],
    reviews: [
      {
        reviewer: "Owner",
        independent: false,
        verdict: "approved",
        evidence: "Read diff",
        fingerprint: "current",
        criteriaVersion: 1,
        at: "now",
      },
    ],
    createdAt: "now",
  };
  const d: ProjectData = {
    schemaVersion: 1,
    project: {
      id: "project",
      schemaVersion: 1,
      name: "Target",
      root: ".",
      baseUrl: "http://localhost/",
      commands: [
        {
          id: "check",
          label: "Check",
          program: "node",
          args: [],
          timeoutMs: 100,
        },
      ],
      files: {},
      createdAt: "now",
    },
    workItems: [item],
    sessions: [],
    findings: [],
    scenarios: [],
    evidence: [],
    runs: [
      {
        id: "run",
        projectId: "project",
        workItemId: "work",
        kind: "command",
        targetId: "check",
        status: "passed",
        code,
        createdAt: "now",
        detail: "",
        steps: [],
        evidenceIds: [],
        manualChecks: [],
      },
    ],
  };
  return { d, item };
}
describe("completion is evidence based", () => {
  it("accepts current evidence and explicit self review", () => {
    const { d, item } = data();
    expect(completionGate(d, item, code).complete).toBe(true);
  });
  it.each([
    "failed",
    "blocked",
    "cancelled",
    "queued",
    "running",
    "manual-required",
  ] as const)("does not accept %s", (status) => {
    const { d, item } = data();
    d.runs[0].status = status;
    expect(completionGate(d, item, code).complete).toBe(false);
  });
  it("invalidates evidence after code changes", () => {
    const { d, item } = data();
    expect(
      completionGate(d, item, { ...code, fingerprint: "changed" }).complete,
    ).toBe(false);
  });
  it("invalidates review after criteria changes", () => {
    const { d, item } = data();
    item.version++;
    expect(completionGate(d, item, code).complete).toBe(false);
  });
  it("keeps retries and uses the last result", () => {
    const { d, item } = data();
    d.runs.push({ ...d.runs[0], id: "retry", status: "failed" });
    expect(completionGate(d, item, code).complete).toBe(false);
    expect(d.runs).toHaveLength(2);
  });
  it("requires completion criteria", () => {
    const { d, item } = data();
    item.criteria = [];
    expect(completionGate(d, item, code).complete).toBe(false);
  });
  it("requires all manual assertions, not just one", () => {
    const { d, item } = data();
    item.requiredCommandIds = [];
    item.requiredScenarioIds = ["s"];
    d.scenarios.push({
      id: "s",
      projectId: "project",
      sessionId: "session",
      name: "Manual",
      version: 1,
      status: "registered",
      steps: [],
      assertions: [
        { id: "a", pageId: "page-1", kind: "manual", expected: "A" },
        { id: "b", pageId: "page-1", kind: "manual", expected: "B" },
      ],
      prerequisites: "",
      createdAt: "now",
    });
    const r = d.runs[0];
    Object.assign(r, {
      kind: "scenario",
      targetId: "s",
      scenarioVersion: 1,
      status: "manual-required",
    });
    r.manualChecks.push({
      assertionId: "a",
      reviewer: "Owner",
      evidence: "Observed A",
      passed: true,
      at: "now",
    });
    expect(completionGate(d, item, code).complete).toBe(false);
    r.manualChecks.push({ ...r.manualChecks[0], assertionId: "b" });
    expect(completionGate(d, item, code).complete).toBe(true);
  });
});
describe("private values", () => {
  it("redacts common credentials", () => {
    expect(
      redact("Authorization: Bearer sensitive-value token=another-value"),
    ).not.toContain("sensitive-value");
    expect(redact("password=hidden")).not.toContain("hidden");
  });
  it("network metadata excludes all query values", () =>
    expect(
      safeUrl("https://user:pass@example.com/a?name=private#fragment"),
    ).toBe("https://example.com/a?name=%5Bredacted%5D"));
  it("replay preserves non-secret URL parameters", () =>
    expect(actionUrl("http://localhost/a?mode=local")).toBe(
      "http://localhost/a?mode=local",
    ));
});
