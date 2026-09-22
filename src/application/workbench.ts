import { randomUUID, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  projectInput,
  actionSchema,
  assertionSchema,
  completionGate,
  validateScenario,
  type Project,
  type ProjectData,
  type Run,
  type Scenario,
  type Action,
  type Assertion,
  type Finding,
  type WorkItem,
} from "../core/model.js";
import { Store, within } from "../adapters/storage.js";
import { codeState } from "../adapters/code-state.js";
import { discoverProject } from "../adapters/discovery.js";
import {
  recordBrowser,
  replayScenario,
  type Recording,
} from "../adapters/browser.js";
import { runCommand } from "../adapters/commands.js";
import {
  createReport,
  markdownReport,
  htmlReport,
  issueTemplate,
} from "../adapters/report.js";
import { generateTest } from "../adapters/generator.js";
import { redact, actionUrl } from "../core/redaction.js";
const now = () => new Date().toISOString();
const productRoot = fileURLToPath(new URL("../../", import.meta.url));
const required = <T>(value: T | undefined, label: string): T => {
  if (!value) throw new Error(`${label}을 찾을 수 없습니다.`);
  return value;
};
export const workInput = z.object({
  title: z.string().min(1),
  requirement: z.string().default(""),
  criteria: z.array(z.string().min(1)).default([]),
  requiredCommandIds: z.array(z.string()).default([]),
  requiredScenarioIds: z.array(z.string()).default([]),
});
export const findingInput = z.object({
  sessionId: z.string().uuid(),
  workItemId: z.string().uuid().optional(),
  title: z.string().min(1),
  expected: z.string().default(""),
  actual: z.string().default(""),
  facts: z.string().default(""),
  hypothesis: z.string().default(""),
  confirmedCause: z.string().default(""),
  blocking: z.boolean().default(true),
});
export class Workbench extends EventEmitter {
  readonly recordings = new Map<string, Recording>();
  private controllers = new Map<string, AbortController>();
  private queue = Promise.resolve();
  private closed = false;
  constructor(
    readonly store: Store,
    readonly headless = false,
  ) {
    super();
  }
  async init() {
    await this.store.init();
    await this.store.recover();
  }
  async discover(input: unknown) {
    const { root } = z
      .object({ root: z.string().min(1).max(4096) })
      .parse(input);
    return discoverProject(root);
  }
  async state(project: Project) {
    const state = await codeState(project.root);
    state.fingerprint = createHash("sha256")
      .update(state.fingerprint)
      .update(
        JSON.stringify({
          url: project.baseUrl,
          commands: project.commands,
          prepare: project.prepareCommandId,
          files: project.files,
          logFiles: project.logFiles,
          browserState: await this.privateState(project.id).then(
            async (file) =>
              file
                ? createHash("sha256")
                    .update(await fs.readFile(file))
                    .digest("hex")
                : null,
          ),
        }),
      )
      .digest("hex");
    return state;
  }
  async connect(input: unknown) {
    const parsed = projectInput.parse(input);
    const root = await fs.realpath(parsed.root);
    if (!(await fs.stat(root)).isDirectory())
      throw new Error("프로젝트 디렉터리가 필요합니다.");
    if (
      parsed.commands.length !== new Set(parsed.commands.map((c) => c.id)).size
    )
      throw new Error("검사 ID가 중복됩니다.");
    if (
      parsed.prepareCommandId &&
      !parsed.commands.some((c) => c.id === parsed.prepareCommandId)
    )
      throw new Error("준비 명령이 등록되지 않았습니다.");
    if (actionUrl(parsed.baseUrl) !== new URL(parsed.baseUrl).href)
      throw new Error("URL에서 인증 정보를 제거하세요.");
    for (const file of [
      ...Object.values(parsed.files),
      ...(parsed.logFiles || []),
    ]) {
      if (path.isAbsolute(file) || path.win32.isAbsolute(file))
        throw new Error("파일 연결은 프로젝트 기준 상대 경로를 사용하세요.");
      within(root, file);
    }
    const project: Project = {
      ...parsed,
      root,
      id: randomUUID(),
      schemaVersion: 1,
      createdAt: now(),
    };
    const data: ProjectData = {
      schemaVersion: 1,
      project,
      workItems: [],
      sessions: [],
      findings: [],
      scenarios: [],
      runs: [],
      evidence: [],
    };
    await this.store.create(data);
    return project;
  }
  async configure(id: string, input: unknown) {
    const old = (await this.store.read(id)).project;
    const parsed = projectInput.parse(input);
    if ((await fs.realpath(parsed.root)) !== old.root)
      throw new Error("다른 프로젝트 폴더는 새 프로젝트로 연결하세요.");
    if (
      parsed.commands.length !== new Set(parsed.commands.map((c) => c.id)).size
    )
      throw new Error("검사 ID가 중복됩니다.");
    if (
      parsed.prepareCommandId &&
      !parsed.commands.some((c) => c.id === parsed.prepareCommandId)
    )
      throw new Error("준비 명령이 등록되지 않았습니다.");
    if (actionUrl(parsed.baseUrl) !== new URL(parsed.baseUrl).href)
      throw new Error("URL에서 인증 정보를 제거하세요.");
    for (const file of [
      ...Object.values(parsed.files),
      ...(parsed.logFiles || []),
    ]) {
      if (path.isAbsolute(file) || path.win32.isAbsolute(file))
        throw new Error("파일 연결은 상대 경로를 사용하세요.");
      within(old.root, file);
    }
    return this.store.update(id, (d) => {
      if (
        d.sessions.some((s) => s.status === "recording") ||
        d.runs.some((r) => ["queued", "running"].includes(r.status))
      )
        throw new Error("진행 중인 검증을 먼저 마치세요.");
      Object.assign(d.project, parsed, { root: old.root });
      return d.project;
    });
  }
  async privateState(id: string) {
    const file = path.join(
      this.store.projectDir(id),
      "private",
      "browser-state.json",
    );
    try {
      await fs.access(file);
      return file;
    } catch {
      return undefined;
    }
  }
  async saveBrowserState(id: string, sid: string) {
    const d = await this.store.read(id);
    required(
      d.sessions.find((s) => s.id === sid),
      "세션",
    );
    const recording = required(this.recordings.get(sid), "진행 중인 브라우저");
    await this.store.atomic(
      path.join(this.store.projectDir(id), "private", "browser-state.json"),
      await recording.context.storageState({ indexedDB: true }),
    );
    return { saved: true };
  }
  async linkedLogs(
    project: Project,
    refs: { sessionId?: string; runId?: string },
  ) {
    const evidenceIds: string[] = [];
    for (const file of project.logFiles || []) {
      const real = await fs.realpath(within(project.root, file));
      within(project.root, path.relative(project.root, real));
      const handle = await fs.open(real, "r");
      try {
        const size = (await handle.stat()).size;
        const bytes = Buffer.alloc(Math.min(size, 128 * 1024));
        await handle.read(
          bytes,
          0,
          bytes.length,
          Math.max(0, size - bytes.length),
        );
        evidenceIds.push(
          await this.evidence(
            project.id,
            Buffer.from(redact(bytes.toString())),
            "연결된 서버 로그 · " + path.basename(file),
            "text/plain",
            refs,
          ),
        );
      } finally {
        await handle.close();
      }
    }
    return evidenceIds;
  }
  async snapshot(id: string) {
    const data = await this.store.read(id);
    const code = await this.state(data.project);
    return {
      ...data,
      code,
      preparation: {
        browserState: !!(await this.privateState(id)),
        serverLogs: data.project.logFiles?.length || 0,
      },
      gates: Object.fromEntries(
        data.workItems.map((w) => [w.id, completionGate(data, w, code)]),
      ),
    };
  }
  async work(id: string, input: unknown, workId?: string) {
    const parsed = workInput.parse(input);
    return this.store.update(id, (d) => {
      for (const cid of parsed.requiredCommandIds)
        required(
          d.project.commands.find((c) => c.id === cid),
          "검사",
        );
      for (const sid of parsed.requiredScenarioIds)
        required(
          d.scenarios.find((s) => s.id === sid),
          "시나리오",
        );
      let item = workId
        ? required(
            d.workItems.find((w) => w.id === workId),
            "작업",
          )
        : undefined;
      if (item) {
        Object.assign(item, parsed, { version: item.version + 1 });
      } else {
        item = {
          ...parsed,
          id: randomUUID(),
          projectId: id,
          version: 1,
          reviews: [],
          createdAt: now(),
        };
        d.workItems.push(item);
      }
      return item;
    });
  }
  async review(id: string, workId: string, input: unknown) {
    const parsed = z
      .object({
        reviewer: z.string().trim().min(1),
        independent: z.boolean().default(false),
        verdict: z.enum(["approved", "changes-requested"]),
        evidence: z.string().trim().min(1),
      })
      .parse(input);
    const d = await this.store.read(id);
    const code = await this.state(d.project);
    return this.store.update(id, (d) => {
      const item = required(
        d.workItems.find((w) => w.id === workId),
        "작업",
      );
      item.reviews.push({
        ...parsed,
        fingerprint: code.fingerprint,
        criteriaVersion: item.version,
        at: now(),
      });
      return item;
    });
  }
  async evidence(
    id: string,
    bytes: Buffer,
    name: string,
    mime: string,
    refs: { sessionId?: string; runId?: string },
  ) {
    const eid = randomUUID();
    const rel = path.join(
      "evidence",
      eid + (mime === "image/png" ? ".png" : ".txt"),
    );
    await fs.mkdir(path.join(this.store.projectDir(id), "evidence"), {
      recursive: true,
    });
    await fs.writeFile(path.join(this.store.projectDir(id), rel), bytes, {
      mode: 0o600,
    });
    await this.store.update(id, (d) => {
      d.evidence.push({
        id: eid,
        projectId: id,
        name,
        mime,
        relativePath: rel,
        createdAt: now(),
        ...refs,
      });
    });
    return eid;
  }
  async startSession(id: string, workItemId?: string) {
    if (this.closed) throw new Error("서비스가 종료 중입니다.");
    const d = await this.store.read(id);
    if (workItemId)
      required(
        d.workItems.find((w) => w.id === workItemId),
        "작업",
      );
    if (d.sessions.some((s) => s.status === "recording"))
      throw new Error("프로젝트에 진행 중인 QA가 있습니다.");
    if (d.runs.some((r) => ["queued", "running"].includes(r.status)))
      throw new Error("실행 중인 검증을 먼저 마치세요.");
    const sid = randomUUID();
    const session = {
      id: sid,
      projectId: id,
      workItemId,
      schemaVersion: 1 as const,
      status: "recording" as const,
      startedAt: now(),
      code: await this.state(d.project),
      eventCount: 0,
      capture: {
        serverLogs: !!d.project.logFiles?.length,
        networkBodies: false as const,
      },
      notes: [
        "새 브라우저 상태에서 시작합니다. 서버·외부 상태는 별도 준비 대상입니다.",
      ],
    };
    await this.store.update(id, (d) => {
      if (
        d.sessions.some((s) => s.status === "recording") ||
        d.runs.some((r) => ["queued", "running"].includes(r.status))
      )
        throw new Error("프로젝트에 진행 중인 QA 또는 검증이 있습니다.");
      d.sessions.push(session);
    });
    try {
      if (d.project.prepareCommandId) {
        const exitCode = await runCommand(
          d.project,
          d.project.prepareCommandId,
          new AbortController().signal,
          () => {},
        );
        if (exitCode !== 0) throw new Error("시작 상태 준비 실패");
      }
      const rec = await recordBrowser(
        d.project,
        {
          event: async (kind, data, pageId) => {
            await this.store.append(id, sid, {
              kind: kind as "action",
              data,
              pageId,
            });
            this.emit("change", id);
          },
          marker: async (data, pageId) => {
            const event = await this.store.append(id, sid, {
              kind: "marker",
              data,
              pageId,
            });
            await this.finding(id, {
              sessionId: sid,
              workItemId,
              title: String(data.title || "검증 지점"),
              expected: String(data.expected || ""),
              actual: String(data.actual || ""),
              blocking: !data.assertion,
            });
            if (data.assertion && event) this.emit("change", id);
          },
          closed: async () => {
            this.recordings.delete(sid);
            await this.store.update(id, (d) => {
              const s = d.sessions.find((s) => s.id === sid);
              if (s?.status === "recording") {
                s.status = "incomplete";
                s.endedAt = now();
                s.notes.push("브라우저가 닫혀 기록이 종료되었습니다.");
              }
            });
            this.emit("change", id);
          },
        },
        this.headless,
        await this.privateState(id),
      );
      this.recordings.set(sid, rec);
      return session;
    } catch (e) {
      await this.store.update(id, (d) => {
        const s = required(
          d.sessions.find((s) => s.id === sid),
          "세션",
        );
        s.status = "incomplete";
        s.endedAt = now();
        s.notes.push(redact((e as Error).message));
      });
      throw e;
    }
  }
  async stopSession(id: string, sid: string) {
    const d = await this.store.read(id);
    required(
      d.sessions.find((s) => s.id === sid),
      "세션",
    );
    let stopError: unknown;
    try {
      await this.recordings.get(sid)?.stop();
    } catch (e) {
      stopError = e;
    }
    this.recordings.delete(sid);
    await this.linkedLogs(d.project, { sessionId: sid }).catch(async (e) => {
      await this.store.update(id, (data) => {
        const session = required(
          data.sessions.find((s) => s.id === sid),
          "세션",
        );
        session.capture.serverLogs = false;
        session.notes.push(
          "서버 로그 수집 실패: " + redact((e as Error).message),
        );
      });
    });
    await this.store.update(id, (d) => {
      const s = required(
        d.sessions.find((s) => s.id === sid),
        "세션",
      );
      if (s.status === "recording") {
        s.status = stopError ? "incomplete" : "stopped";
        s.endedAt = now();
        if (stopError) s.notes.push(redact((stopError as Error).message));
      }
    });
    this.emit("change", id);
    if (stopError) throw stopError;
  }
  async finding(id: string, input: unknown) {
    const parsed = findingInput.parse(input);
    const d = await this.store.read(id);
    required(
      d.sessions.find((s) => s.id === parsed.sessionId),
      "세션",
    );
    if (parsed.workItemId)
      required(
        d.workItems.find((w) => w.id === parsed.workItemId),
        "작업",
      );
    const evidenceIds: string[] = [];
    const rec = this.recordings.get(parsed.sessionId);
    if (rec)
      try {
        evidenceIds.push(
          await this.evidence(
            id,
            await rec.screenshot(),
            "발견 시점 화면",
            "image/png",
            { sessionId: parsed.sessionId },
          ),
        );
      } catch {}
    const finding: Finding = {
      ...parsed,
      id: randomUUID(),
      projectId: id,
      status: "open",
      createdAt: now(),
      evidenceIds,
    };
    await this.store.update(id, (d) => {
      d.findings.push(finding);
    });
    this.emit("change", id);
    return finding;
  }
  async updateFinding(id: string, fid: string, input: unknown) {
    const parsed = z
      .object({
        title: z.string().min(1).optional(),
        expected: z.string().optional(),
        actual: z.string().optional(),
        facts: z.string().optional(),
        hypothesis: z.string().optional(),
        confirmedCause: z.string().optional(),
        blocking: z.boolean().optional(),
        workItemId: z.string().uuid().optional(),
        resolutionRunId: z.string().uuid().optional(),
      })
      .parse(input);
    const current = await this.state((await this.store.read(id)).project);
    return this.store.update(id, (d) => {
      const f = required(
        d.findings.find((f) => f.id === fid),
        "발견",
      );
      if (parsed.workItemId)
        required(
          d.workItems.find((w) => w.id === parsed.workItemId),
          "작업",
        );
      if (parsed.resolutionRunId) {
        const r = required(
          d.runs.find((r) => r.id === parsed.resolutionRunId),
          "실행",
        );
        const scenario = d.scenarios.find((s) => s.id === r.targetId);
        if (
          r.status !== "passed" ||
          r.code.fingerprint !== current.fingerprint ||
          r.kind !== "scenario" ||
          !scenario ||
          scenario.sessionId !== f.sessionId ||
          scenario.version !== r.scenarioVersion ||
          ((parsed.workItemId || f.workItemId) &&
            r.workItemId !== (parsed.workItemId || f.workItemId))
        )
          throw new Error(
            "같은 발견 세션에서 파생한 시나리오의 현재 코드 통과 실행을 연결하세요.",
          );
        f.status = "resolved";
      }
      Object.assign(f, parsed);
      return f;
    });
  }
  async draft(id: string, input: unknown) {
    const parsed = z
      .object({
        sessionId: z.string().uuid(),
        name: z.string().min(1),
        workItemId: z.string().uuid().optional(),
        prerequisites: z.string().default(""),
        assertions: z.array(assertionSchema).default([]),
      })
      .parse(input);
    const d = await this.store.read(id);
    const session = required(
      d.sessions.find((s) => s.id === parsed.sessionId),
      "세션",
    );
    if (session.status === "recording")
      throw new Error("기록 종료 후 초안을 생성하세요.");
    if (parsed.workItemId)
      required(
        d.workItems.find((w) => w.id === parsed.workItemId),
        "작업",
      );
    const events = await this.store.events(id, session.id);
    const steps: Action[] = [];
    const assertions: Assertion[] = [...parsed.assertions];
    for (const e of events) {
      if (e.kind === "action") {
        const action = actionSchema.parse({
          ...e.data,
          pageId: e.pageId || "page-1",
          id: e.id,
        });
        if (action.type === "navigate" && action.detail === "observed")
          continue;
        if (
          action.type === "navigate" &&
          steps.length === 0 &&
          action.url === d.project.baseUrl
        )
          continue;
        if (action.type === "page-close" && e.pageId === "page-1") continue;
        if (
          action.type === "click" &&
          action.detail === "double-second" &&
          steps.at(-1)?.type === "click"
        ) {
          steps.pop();
          action.detail = "double";
        }
        steps.push(action);
      }
      if (e.kind === "marker" && e.data.assertion) {
        const result = assertionSchema.safeParse({
          ...(e.data.assertion as object),
          id: randomUUID(),
          pageId: e.pageId || "page-1",
          afterStep: steps.length,
        });
        if (result.success) assertions.push(result.data);
      }
    }
    if (session.status === "incomplete")
      steps.push({
        type: "manual",
        pageId: "page-1",
        detail: "불완전한 원본 기록: 전체 흐름 수동 확인 필요",
      });
    validateScenario(steps, assertions);
    const scenario: Scenario = {
      ...parsed,
      assertions,
      steps,
      id: randomUUID(),
      projectId: id,
      version: 1,
      status: "draft",
      createdAt: now(),
    };
    await this.store.update(id, (d) => {
      d.scenarios.push(scenario);
    });
    return scenario;
  }
  async updateScenario(id: string, sid: string, input: unknown) {
    const parsed = z
      .object({
        name: z.string().min(1),
        steps: z.array(actionSchema),
        assertions: z.array(assertionSchema),
        prerequisites: z.string(),
        workItemId: z.string().uuid().optional(),
      })
      .parse(input);
    validateScenario(parsed.steps, parsed.assertions);
    return this.store.update(id, (d) => {
      if (parsed.workItemId)
        required(
          d.workItems.find((w) => w.id === parsed.workItemId),
          "작업",
        );
      const s = required(
        d.scenarios.find((s) => s.id === sid),
        "시나리오",
      );
      Object.assign(s, parsed, {
        version: s.version + 1,
        status: "draft",
        reviewedBy: undefined,
        reviewRunId: undefined,
      });
      return s;
    });
  }
  async register(id: string, sid: string, input: unknown) {
    const parsed = z
      .object({ reviewer: z.string().trim().min(1), runId: z.string().uuid() })
      .parse(input);
    const data = await this.store.read(id);
    const code = await this.state(data.project);
    return this.store.update(id, (d) => {
      const s = required(
        d.scenarios.find((s) => s.id === sid),
        "시나리오",
      );
      const run = required(
        d.runs.find(
          (r) =>
            r.id === parsed.runId &&
            r.targetId === sid &&
            r.scenarioVersion === s.version &&
            r.code.fingerprint === code.fingerprint,
        ),
        "현재 시나리오의 실행",
      );
      const manualIds =
        s.steps.some((s) => s.type === "manual") || !s.assertions.length
          ? ["manual-flow"]
          : s.assertions.filter((a) => a.kind === "manual").map((a) => a.id);
      const reviewedManual =
        run.status === "manual-required" &&
        manualIds.length > 0 &&
        manualIds.every(
          (id) =>
            run.manualChecks.filter((c) => c.assertionId === id).at(-1)?.passed,
        );
      if (run.status !== "passed" && !reviewedManual)
        throw new Error("통과한 자동 검증 또는 수동 검증 근거가 필요합니다.");
      s.status = "registered";
      s.reviewedBy = parsed.reviewer;
      s.reviewRunId = parsed.runId;
      return s;
    });
  }
  async manual(id: string, rid: string, input: unknown) {
    const parsed = z
      .object({
        assertionId: z.string().min(1),
        reviewer: z.string().trim().min(1),
        evidence: z.string().trim().min(1),
        passed: z.boolean(),
      })
      .parse(input);
    return this.store.update(id, (d) => {
      const run = required(
        d.runs.find((r) => r.id === rid),
        "실행",
      );
      if (run.status !== "manual-required")
        throw new Error("수동 검증 대기 상태가 아닙니다.");
      const scenario = required(
        d.scenarios.find(
          (s) => s.id === run.targetId && s.version === run.scenarioVersion,
        ),
        "시나리오",
      );
      const valid =
        scenario.steps.some((s) => s.type === "manual") ||
        !scenario.assertions.length
          ? ["manual-flow"]
          : scenario.assertions
              .filter((a) => a.kind === "manual")
              .map((a) => a.id);
      if (!valid.includes(parsed.assertionId))
        throw new Error("수동 확인 항목이 일치하지 않습니다.");
      run.manualChecks.push({ ...parsed, at: now() });
      return run;
    });
  }
  async startRun(id: string, input: unknown) {
    if (this.closed) throw new Error("서비스가 종료 중입니다.");
    const parsed = z
      .object({
        kind: z.enum(["scenario", "command"]),
        targetId: z.string().min(1),
        workItemId: z.string().uuid().optional(),
      })
      .parse(input);
    const d = await this.store.read(id);
    if (d.sessions.some((s) => s.status === "recording"))
      throw new Error("QA 기록을 먼저 종료하세요.");
    if (parsed.workItemId)
      required(
        d.workItems.find((w) => w.id === parsed.workItemId),
        "작업",
      );
    const scenario =
      parsed.kind === "scenario"
        ? required(
            d.scenarios.find((s) => s.id === parsed.targetId),
            "시나리오",
          )
        : undefined;
    if (parsed.kind === "command")
      required(
        d.project.commands.find((c) => c.id === parsed.targetId),
        "검사",
      );
    const run: Run = {
      ...parsed,
      id: randomUUID(),
      projectId: id,
      scenarioVersion: scenario?.version,
      scenarioSnapshot: scenario ? structuredClone(scenario) : undefined,
      status: "queued",
      code: await this.state(d.project),
      createdAt: now(),
      detail: "실행 대기",
      steps: [],
      evidenceIds: [],
      manualChecks: [],
    };
    await this.store.update(id, (d) => {
      if (d.sessions.some((s) => s.status === "recording"))
        throw new Error("QA 기록을 먼저 종료하세요.");
      d.runs.push(run);
    });
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    const task = () =>
      this.execute(
        d.project,
        run,
        scenario ? structuredClone(scenario) : undefined,
        controller,
      );
    this.queue = this.queue.then(task, task);
    void this.queue.catch(() => {});
    this.emit("change", id);
    return run;
  }
  private async execute(
    project: Project,
    run: Run,
    scenario: Scenario | undefined,
    controller: AbortController,
  ) {
    const id = project.id;
    const set = async (p: Partial<Run>) => {
      await this.store.update(id, (d) =>
        Object.assign(
          required(
            d.runs.find((r) => r.id === run.id),
            "실행",
          ),
          p,
        ),
      );
      this.emit("change", id);
    };
    let log = "";
    const output = (s: string) => {
      log = (log + s).slice(-1024 * 1024);
    };
    const timer = setTimeout(() => controller.abort("timeout"), 300000);
    let status: Run["status"] = "blocked",
      detail = "";
    const evidenceIds: string[] = [];
    const artifactDir = path.join(this.store.projectDir(id), "runs", run.id);
    try {
      if (controller.signal.aborted) {
        status = "cancelled";
        detail = "실행 전 취소";
        return;
      }
      const current = await this.state(project);
      if (current.fingerprint !== run.code.fingerprint)
        throw new Error("대기 중 코드가 변경됐습니다. 새 실행을 요청하세요.");
      await set({ status: "running", detail: "검증 중" });
      if (project.prepareCommandId) {
        const result = await runCommand(
          project,
          project.prepareCommandId,
          controller.signal,
          output,
        );
        if (result !== 0) throw new Error("시작 상태 준비 실패");
      }
      if (scenario) {
        const result = await replayScenario(
          project,
          scenario.steps,
          scenario.assertions,
          {
            headless: this.headless,
            signal: controller.signal,
            artifactDir,
            storageState: await this.privateState(id),
            onStep: async (index, status, detail) => {
              await this.store.update(id, (d) => {
                required(
                  d.runs.find((r) => r.id === run.id),
                  "실행",
                ).steps.push({ index, status, detail });
              });
              this.emit("change", id);
            },
          },
        );
        status = result.manual ? "manual-required" : "passed";
        detail = result.manual
          ? "자동화되지 않은 구간 또는 기대 결과를 수동으로 확인하세요."
          : "명시된 기대 결과를 확인했습니다.";
      } else {
        const exitCode = await runCommand(
          project,
          run.targetId,
          controller.signal,
          output,
        );
        status = exitCode === 0 ? "passed" : "failed";
        detail = `등록된 명령 종료 코드: ${exitCode}`;
      }
      if ((await this.state(project)).fingerprint !== run.code.fingerprint) {
        status = "blocked";
        detail =
          "실행 중 코드가 변경됐습니다. 결과를 최신 코드의 통과 근거로 사용할 수 없습니다.";
      }
    } catch (e) {
      detail = redact((e as Error).message);
      status = controller.signal.aborted
        ? controller.signal.reason === "timeout"
          ? "blocked"
          : "cancelled"
        : /expect\(|Expected:|Received:|Timed out.*expect/.test(detail)
          ? "failed"
          : "blocked";
    } finally {
      clearTimeout(timer);
      this.controllers.delete(run.id);
      try {
        evidenceIds.push(
          ...(await this.linkedLogs(project, { runId: run.id })),
        );
      } catch (e) {
        detail +=
          "\n연결된 서버 로그 수집 실패: " + redact((e as Error).message);
        if (status === "passed") status = "blocked";
      }
      if (log)
        evidenceIds.push(
          await this.evidence(id, Buffer.from(log), "검사 출력", "text/plain", {
            runId: run.id,
          }),
        );
      try {
        evidenceIds.push(
          await this.evidence(
            id,
            await fs.readFile(path.join(artifactDir, "result.png")),
            "재실행 결과 화면",
            "image/png",
            { runId: run.id },
          ),
        );
      } catch {}
      await set({ status, detail, endedAt: now(), evidenceIds });
    }
  }
  async cancel(id: string, rid: string) {
    const d = await this.store.read(id);
    required(
      d.runs.find((r) => r.id === rid),
      "실행",
    );
    this.controllers.get(rid)?.abort("user");
  }
  async report(id: string, workItemId?: string) {
    const data = await this.store.read(id);
    if (workItemId)
      required(
        data.workItems.find((w) => w.id === workItemId),
        "작업",
      );
    return createReport(data, await this.state(data.project), workItemId);
  }
  async exportReport(id: string, input: unknown) {
    const parsed = z
      .object({
        destination: z.string().min(1),
        workItemId: z.string().uuid().optional(),
        evidenceIds: z.array(z.string().uuid()).default([]),
      })
      .parse(input);
    const destination = path.resolve(parsed.destination);
    const relative = path.relative(productRoot, destination);
    if (!relative.startsWith("..") && !path.isAbsolute(relative))
      throw new Error("제품 저장소 밖의 출력 위치를 선택하세요.");
    await fs.mkdir(destination, { recursive: true });
    const real = await fs.realpath(destination);
    if (
      !path.relative(productRoot, real).startsWith("..") &&
      !path.isAbsolute(path.relative(productRoot, real))
    )
      throw new Error(
        "제품 저장소 내부에는 외부 프로젝트 자료를 저장할 수 없습니다.",
      );
    const folder = await fs.mkdtemp(path.join(real, "verification-"));
    const report = await this.report(id, parsed.workItemId);
    const data = await this.store.read(id);
    report.evidence = report.evidence.filter((e) =>
      parsed.evidenceIds.includes(e.id),
    );
    await fs.mkdir(path.join(folder, "evidence"));
    for (const e of report.evidence) {
      const source = required(
        data.evidence.find((x) => x.id === e.id),
        "근거",
      );
      await fs.copyFile(
        within(this.store.projectDir(id), source.relativePath),
        path.join(
          folder,
          "evidence",
          e.id + (e.mime === "image/png" ? ".png" : ".txt"),
        ),
      );
    }
    await Promise.all([
      fs.writeFile(
        path.join(folder, "report.json"),
        JSON.stringify(report, null, 2),
      ),
      fs.writeFile(path.join(folder, "report.md"), markdownReport(report)),
      fs.writeFile(path.join(folder, "report.html"), htmlReport(report)),
      fs.writeFile(path.join(folder, "issue.md"), issueTemplate(report)),
    ]);
    return { folder };
  }
  async exportProject(id: string) {
    const { project } = await this.store.read(id);
    const values = project.commands.flatMap((c) => [c.program, ...c.args]);
    if (
      values.some(
        (v) =>
          path.isAbsolute(v) ||
          path.win32.isAbsolute(v) ||
          v.includes(project.root) ||
          redact(v) !== v,
      )
    )
      throw new Error(
        "공유 설정에 로컬 절대 경로나 인증 문자열이 있습니다. 상대 경로와 환경 변수로 분리한 뒤 내보내세요.",
      );
    return {
      schemaVersion: 1,
      name: project.name,
      root: ".",
      baseUrl: project.baseUrl,
      commands: project.commands,
      prepareCommandId: project.prepareCommandId,
      files: project.files,
      logFiles: project.logFiles,
    };
  }
  async testSource(id: string, sid: string) {
    const d = await this.store.read(id);
    return generateTest(
      required(
        d.scenarios.find((s) => s.id === sid),
        "시나리오",
      ),
    );
  }
  async idle() {
    await this.queue;
  }
  async close() {
    this.closed = true;
    for (const c of this.controllers.values()) c.abort();
    for (const data of await this.store.list())
      for (const s of data.sessions)
        if (this.recordings.has(s.id))
          await this.stopSession(data.project.id, s.id);
    await this.idle();
  }
}
