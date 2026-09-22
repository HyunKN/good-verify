import { z } from "zod";

export const idSchema = z.string().uuid();
export const commandSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  label: z.string().min(1),
  program: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().min(100).max(3600000).default(120000),
});
export const projectInput = z.object({
  name: z.string().min(1).max(100),
  root: z.string().min(1),
  baseUrl: z
    .url()
    .refine((v) => ["http:", "https:"].includes(new URL(v).protocol)),
  commands: z.array(commandSchema).default([]),
  prepareCommandId: z.string().optional(),
  files: z.record(z.string(), z.string()).default({}),
  logFiles: z.array(z.string()).optional(),
});
export type Project = z.infer<typeof projectInput> & {
  id: string;
  schemaVersion: 1;
  createdAt: string;
};
export type CodeState = {
  revision: string;
  dirty: boolean;
  fingerprint: string;
  capturedAt: string;
};
export const locatorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("testId"), value: z.string() }),
  z.object({ kind: z.literal("label"), value: z.string() }),
  z.object({ kind: z.literal("role"), value: z.string(), name: z.string() }),
  z.object({ kind: z.literal("text"), value: z.string() }),
  z.object({ kind: z.literal("css"), value: z.string() }),
]);
export type LocatorSpec = z.infer<typeof locatorSchema>;
export const actionSchema = z.object({
  id: z.string().optional(),
  type: z.enum([
    "navigate",
    "click",
    "fill",
    "check",
    "select",
    "press",
    "reload",
    "upload",
    "manual",
    "page-open",
    "page-close",
  ]),
  pageId: z.string().default("page-1"),
  locator: locatorSchema.optional(),
  value: z.string().optional(),
  checked: z.boolean().optional(),
  url: z.string().optional(),
  fileId: z.string().optional(),
  detail: z.string().optional(),
  timestamp: z.number().optional(),
});
export type Action = z.infer<typeof actionSchema>;
export const assertionSchema = z.object({
  id: z.string(),
  pageId: z.string().default("page-1"),
  kind: z.enum([
    "visible",
    "hidden",
    "text",
    "value",
    "count",
    "url",
    "manual",
  ]),
  locator: locatorSchema.optional(),
  expected: z.string(),
  afterStep: z.number().int().min(0).optional(),
});
export type Assertion = z.infer<typeof assertionSchema>;
export function validateScenario(steps: Action[], assertions: Assertion[]) {
  if (new Set(assertions.map((a) => a.id)).size !== assertions.length)
    throw new Error("기대 결과 ID가 중복됩니다.");
  for (const a of assertions) {
    if ((a.afterStep ?? steps.length) > steps.length)
      throw new Error("검증 단계가 범위를 벗어났습니다.");
    if (!["url", "manual"].includes(a.kind) && !a.locator)
      throw new Error("검증 대상이 필요합니다.");
    if (
      a.kind === "count" &&
      (!a.expected.trim() ||
        !Number.isInteger(Number(a.expected)) ||
        Number(a.expected) < 0)
    )
      throw new Error("개수는 0 이상의 정수여야 합니다.");
  }
}
export type EventRecord = {
  id: string;
  sessionId: string;
  seq: number;
  at: string;
  kind:
    "action" | "console" | "error" | "network" | "marker" | "download" | "gap";
  pageId?: string;
  data: Record<string, unknown>;
};
export type Session = {
  id: string;
  projectId: string;
  workItemId?: string;
  schemaVersion: 1;
  status: "recording" | "stopped" | "incomplete";
  startedAt: string;
  endedAt?: string;
  code: CodeState;
  eventCount: number;
  capture: { serverLogs: boolean; networkBodies: false };
  notes: string[];
};
export type Finding = {
  id: string;
  projectId: string;
  sessionId: string;
  workItemId?: string;
  title: string;
  expected: string;
  actual: string;
  facts: string;
  hypothesis: string;
  confirmedCause: string;
  blocking: boolean;
  status: "open" | "resolved";
  evidenceIds: string[];
  createdAt: string;
  resolutionRunId?: string;
};
export type Evidence = {
  id: string;
  projectId: string;
  sessionId?: string;
  runId?: string;
  name: string;
  relativePath: string;
  mime: string;
  createdAt: string;
};
export type Scenario = {
  id: string;
  projectId: string;
  sessionId: string;
  workItemId?: string;
  name: string;
  version: number;
  status: "draft" | "registered";
  steps: Action[];
  assertions: Assertion[];
  prerequisites: string;
  createdAt: string;
  reviewedBy?: string;
  reviewRunId?: string;
};
export type RunStatus =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "manual-required";
export type Run = {
  id: string;
  projectId: string;
  workItemId?: string;
  kind: "scenario" | "command";
  targetId: string;
  scenarioVersion?: number;
  scenarioSnapshot?: Scenario;
  status: RunStatus;
  code: CodeState;
  createdAt: string;
  endedAt?: string;
  detail: string;
  steps: { index: number; status: string; detail: string }[];
  evidenceIds: string[];
  manualChecks: {
    assertionId: string;
    reviewer: string;
    evidence: string;
    passed: boolean;
    at: string;
  }[];
};
export type Review = {
  reviewer: string;
  independent: boolean;
  verdict: "approved" | "changes-requested";
  evidence: string;
  fingerprint: string;
  criteriaVersion: number;
  at: string;
};
export type WorkItem = {
  id: string;
  projectId: string;
  title: string;
  requirement: string;
  criteria: string[];
  version: number;
  requiredCommandIds: string[];
  requiredScenarioIds: string[];
  reviews: Review[];
  createdAt: string;
};
export type ProjectData = {
  schemaVersion: 1;
  project: Project;
  workItems: WorkItem[];
  sessions: Session[];
  findings: Finding[];
  scenarios: Scenario[];
  runs: Run[];
  evidence: Evidence[];
};
export type Gate = {
  complete: boolean;
  reasons: string[];
  checks: { label: string; status: string }[];
};
export const labels: Record<RunStatus, string> = {
  queued: "대기",
  running: "실행 중",
  passed: "통과",
  failed: "실패",
  blocked: "실행 불가",
  cancelled: "취소",
  "manual-required": "수동 확인 필요",
};

export function completionGate(
  data: ProjectData,
  item: WorkItem,
  code: CodeState,
): Gate {
  const reasons: string[] = [];
  const checks: Gate["checks"] = [];
  if (!item.requirement.trim() || !item.criteria.length)
    reasons.push("요구사항과 완료 기준이 필요합니다.");
  if (!item.requiredCommandIds.length && !item.requiredScenarioIds.length)
    reasons.push("필수 검사 또는 시나리오를 연결하세요.");
  for (const [kind, ids] of [
    ["command", item.requiredCommandIds],
    ["scenario", item.requiredScenarioIds],
  ] as const) {
    for (const id of ids) {
      const scenario = data.scenarios.find((s) => s.id === id);
      const run = data.runs
        .filter(
          (r) =>
            r.workItemId === item.id &&
            r.kind === kind &&
            r.targetId === id &&
            r.code.fingerprint === code.fingerprint &&
            (kind === "command" || r.scenarioVersion === scenario?.version),
        )
        .at(-1);
      const manualIds = scenario
        ? scenario.steps.some((s) => s.type === "manual") ||
          !scenario.assertions.length
          ? ["manual-flow"]
          : scenario.assertions
              .filter((a) => a.kind === "manual")
              .map((a) => a.id)
        : [];
      const manualPassed =
        run?.status === "manual-required" &&
        manualIds.length > 0 &&
        manualIds.every(
          (id) =>
            run.manualChecks.filter((m) => m.assertionId === id).at(-1)?.passed,
        );
      const valid =
        (run?.status === "passed" || manualPassed) &&
        (kind === "command"
          ? data.project.commands.some((c) => c.id === id)
          : scenario?.status === "registered");
      const label =
        kind === "command"
          ? (data.project.commands.find((c) => c.id === id)?.label ?? id)
          : (scenario?.name ?? id);
      checks.push({
        label,
        status: valid
          ? manualPassed
            ? "수동 검증 포함"
            : "통과"
          : run
            ? labels[run.status]
            : "미검증",
      });
      if (!valid)
        reasons.push(`${label}: 현재 코드의 검증과 등록이 필요합니다.`);
    }
  }
  if (
    data.findings.some(
      (f) => f.workItemId === item.id && f.blocking && f.status === "open",
    )
  )
    reasons.push("완료를 막는 발견 사항이 남아 있습니다.");
  const review = item.reviews
    .filter(
      (r) =>
        r.fingerprint === code.fingerprint &&
        r.criteriaVersion === item.version,
    )
    .at(-1);
  if (review?.verdict !== "approved")
    reasons.push("현재 코드와 완료 기준에 대한 리뷰 승인이 필요합니다.");
  return { complete: reasons.length === 0, reasons, checks };
}
