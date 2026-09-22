import React, { useEffect, useState, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import type {
  Project,
  ProjectData,
  CodeState,
  Gate,
  Scenario,
  Finding,
  EventRecord,
  WorkItem,
  Run,
  Assertion,
} from "../core/model";
import { labels } from "../core/model";
import "./style.css";
import { usePresence } from "./use-presence";
import type { ProjectSuggestions } from "../adapters/discovery";
type Snapshot = ProjectData & {
  code: CodeState;
  gates: Record<string, Gate>;
  preparation: { browserState: boolean; serverLogs: number };
};
async function api<T>(
  route: string,
  body?: unknown,
  method = body ? "POST" : "GET",
): Promise<T> {
  const res = await fetch("/api/v1" + route, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "요청 실패");
  }
  return res.json();
}
function download(name: string, text: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
const time = (s: string) => new Date(s).toLocaleString("ko-KR");
const short = (s: string) => s.slice(0, 8);
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Status({ value }: { value: string }) {
  return (
    <span className={"status " + value}>
      {(labels as Record<string, string>)[value] ||
        (
          {
            recording: "기록 중",
            stopped: "기록 종료",
            incomplete: "불완전",
            registered: "등록됨",
            draft: "초안",
            open: "미해결",
            resolved: "해결",
          } as Record<string, string>
        )[value] ||
        value}
    </span>
  );
}
function App() {
  const navigation = usePresence("overview");
  const tab = navigation.shown,
    setTab = navigation.request;
  const dialogPresence = usePresence<React.ReactNode>(undefined, true);
  const modal = dialogPresence.shown,
    setModal = dialogPresence.request;
  const [projects, setProjects] = useState<Project[]>([]),
    [pid, setPid] = useState(""),
    [data, setData] = useState<Snapshot>(),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [workId, setWorkId] = useState(""),
    [sessionId, setSessionId] = useState(""),
    [events, setEvents] = useState<EventRecord[]>([]),
    [selectedEvidence, setSelectedEvidence] = useState<string[]>([]);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const base = "/projects/" + pid;
  const refresh = useCallback(async () => {
    const p = await api<{ projects: Project[] }>("/projects");
    setProjects(p.projects);
    if (pid) {
      const d = await api<Snapshot>("/projects/" + pid);
      setData(d);
    } else if (p.projects[0]) setPid(p.projects[0].id);
  }, [pid]);
  const act = async (fn: () => Promise<unknown>, message = "저장했습니다.") => {
    setBusy(true);
    setError("");
    try {
      const result = await fn();
      await refresh();
      setNotice(typeof result === "string" ? result : message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void fetch("/api/v1/ui-session", {
      method: "POST",
      headers: { "x-gv-ui": "1" },
    })
      .then((r) => {
        if (!r.ok)
          throw new Error(
            "로컬 서비스에 연결할 수 없습니다. 실행 주소를 확인하세요.",
          );
        setReady(true);
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (ready) void refresh().catch((e) => setError(e.message));
  }, [refresh, ready]);
  useEffect(() => {
    if (!pid || !ready) return;
    const stream = new EventSource("/api/v1/projects/" + pid + "/events");
    let timer: ReturnType<typeof setTimeout>;
    stream.addEventListener("change", () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => void refresh().catch((e) => setError(e.message)),
        500,
      );
    });
    return () => {
      stream.close();
      clearTimeout(timer);
    };
  }, [pid, ready, refresh]);
  useEffect(() => {
    if (pid && sessionId)
      void api<{ events: EventRecord[] }>(
        base + "/sessions/" + sessionId + "/events",
      )
        .then((r) => setEvents(r.events))
        .catch((e) => setError(e.message));
    else setEvents([]);
  }, [
    pid,
    sessionId,
    data?.sessions.find((s) => s.id === sessionId)?.eventCount,
  ]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement as HTMLElement;
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    document.querySelector("main")?.setAttribute("inert", "");
    document.querySelector("aside")?.setAttribute("inert", "");
    dialog?.querySelector<HTMLElement>("input,button,textarea,select")?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) setModal(undefined);
      if (event.key !== "Tab" || !dialog) return;
      const controls = [
        ...dialog.querySelectorAll<HTMLElement>(
          "input,button,textarea,select,a[href]",
        ),
      ].filter(
        (el) => !el.hasAttribute("disabled") && el.getClientRects().length,
      );
      const first = controls[0],
        last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("keydown", keyboard);
      document.querySelector("main")?.removeAttribute("inert");
      document.querySelector("aside")?.removeAttribute("inert");
      previous?.focus();
    };
  }, [modal, setModal]);
  const openProject = (project?: Project) =>
    setModal(
      <ProjectForm
        project={project}
        onCancel={() => setModal(undefined)}
        onSave={(input) =>
          act(async () => {
            const p = await api<Project>(
              "/projects" + (project ? "/" + project.id : ""),
              input,
              project ? "PUT" : "POST",
            );
            setPid(p.id);
            setModal(undefined);
          }, "프로젝트를 연결했습니다.")
        }
      />,
    );
  const openWork = (item?: WorkItem) =>
    setModal(
      <WorkForm
        data={data!}
        item={item}
        onCancel={() => setModal(undefined)}
        onSave={(input) =>
          act(async () => {
            const w = await api<WorkItem>(
              base + "/work-items" + (item ? "/" + item.id : ""),
              input,
              item ? "PUT" : "POST",
            );
            setWorkId(w.id);
            setModal(undefined);
          })
        }
      />,
    );
  const openFinding = (finding?: Finding) =>
    setModal(
      <FindingForm
        finding={finding}
        sessionId={sessionId}
        workId={workId}
        onCancel={() => setModal(undefined)}
        onSave={(input) =>
          act(async () => {
            await api(
              base + "/findings" + (finding ? "/" + finding.id : ""),
              input,
              finding ? "PATCH" : "POST",
            );
            setModal(undefined);
          })
        }
      />,
    );
  const openScenario = (scenario: Scenario) =>
    setModal(
      <ScenarioForm
        scenario={scenario}
        onCancel={() => setModal(undefined)}
        onSave={(input) =>
          act(async () => {
            await api(base + "/scenarios/" + scenario.id, input, "PUT");
            setModal(undefined);
          })
        }
      />,
    );
  const run = (kind: "command" | "scenario", targetId: string) =>
    act(
      () =>
        api(base + "/runs", {
          kind,
          targetId,
          workItemId: workId || undefined,
        }),
      "검증 실행을 요청했습니다.",
    );
  const project = data?.project;
  const activeSession = data?.sessions.find((s) => s.status === "recording");
  return (
    <div className="app">
      <aside className="rail">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setTab("overview");
          }}
        >
          <span className="brand-mark">
            g<span>v</span>
          </span>
          <strong>
            good-verify<small>VERIFICATION WORKBENCH</small>
          </strong>
        </a>
        <div className="project-select">
          <label htmlFor="project">프로젝트</label>
          <select
            id="project"
            value={pid}
            onChange={(e) => {
              setPid(e.target.value);
              setWorkId("");
              setSessionId("");
            }}
          >
            <option value="">프로젝트 선택</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="text-button" onClick={() => openProject()}>
            ＋ 프로젝트 연결
          </button>
          {data && (
            <button
              className="text-button"
              onClick={() => openProject(data.project)}
            >
              프로젝트 설정
            </button>
          )}
        </div>
        <nav>
          {[
            ["overview", "01", "작업과 완료 기준"],
            ["sessions", "02", "QA 기록"],
            ["scenarios", "03", "검증 시나리오"],
            ["runs", "04", "실행 결과"],
            ["reports", "05", "보고서"],
          ].map(([key, num, name]) => (
            <button
              key={key}
              className={tab === key ? "active" : ""}
              aria-current={tab === key ? "page" : undefined}
              onClick={() => setTab(key)}
            >
              <span>{num}</span>
              {name}
            </button>
          ))}
        </nav>
        <div className="rail-bottom">
          <span className="online-dot" /> Local workspace
          <p>기록은 이 기기에 보관됩니다.</p>
          <small>ALPHA · 0.1.0</small>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div>
            <span className="eyebrow">
              WORKSPACE / {project?.name || "시작하기"}
            </span>
            <span className="local-label">로컬 전용</span>
          </div>
          <button
            className="quiet"
            disabled={busy || !pid}
            onClick={() => void act(refresh, "최신 코드 상태를 확인했습니다.")}
          >
            ↻ 새로 확인
          </button>
        </header>
        <div
          className="content"
          ref={navigation.ref}
          inert={navigation.leaving}
        >
          {error && (
            <div role="alert" className="alert">
              <strong>확인이 필요합니다</strong>
              <p>{error}</p>
              <button onClick={() => setError("")}>닫기</button>
            </div>
          )}
          {notice && (
            <div role="status" className="toast">
              ✓ {notice}
            </div>
          )}
          {!data ? (
            <section className="welcome">
              <h1>프로젝트를 연결하세요</h1>
              <p>
                프로젝트를 연결하고 QA를 시작하세요.
                <br />
                조작, 발견, 재현 결과를 하나의 기록으로 남깁니다.
              </p>
              <button className="primary" onClick={() => openProject()}>
                프로젝트 연결 <span>↗</span>
              </button>
              <div className="welcome-line">
                01 연결 <i /> 02 기록 <i /> 03 재현 <i /> 04 검증
              </div>
            </section>
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <h1>
                    {
                      {
                        overview: "작업과 완료 기준",
                        sessions: "QA 기록",
                        scenarios: "검증 시나리오",
                        runs: "실행 결과",
                        reports: "검증 보고서",
                      }[tab]
                    }
                  </h1>
                </div>
                {tab === "overview" ? (
                  <button className="primary" onClick={() => openWork()}>
                    ＋ 작업 만들기
                  </button>
                ) : tab === "sessions" ? (
                  activeSession ? (
                    <button
                      className="danger"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          () =>
                            api(
                              base + "/sessions/" + activeSession.id + "/stop",
                              {},
                            ),
                          "기록을 종료했습니다.",
                        )
                      }
                    >
                      ■ 기록 종료
                    </button>
                  ) : (
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          const s = await api<{ id: string }>(
                            base + "/sessions",
                            { workItemId: workId || undefined },
                          );
                          setSessionId(s.id);
                        }, "전용 QA 브라우저를 열었습니다.")
                      }
                    >
                      ● QA 시작
                    </button>
                  )
                ) : null}
              </div>
              <div className="context-line">
                <span>
                  코드{" "}
                  <code>
                    {data.code.revision === "unversioned"
                      ? "Git 없음"
                      : short(data.code.revision)}
                  </code>
                  {data.code.dirty ? " · 변경 포함" : ""}
                </span>
                <span>
                  상태 <code>{short(data.code.fingerprint)}</code>
                </span>
                <label>
                  연결할 작업{" "}
                  <select
                    value={workId}
                    onChange={(e) => setWorkId(e.target.value)}
                  >
                    <option value="">자유 QA / 작업 선택</option>
                    {data.workItems.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.title}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {tab === "overview" && (
                <>
                  <p className="intro">
                    기대하는 동작을 정하고, 검사와 리뷰의 근거를 연결하세요.
                  </p>
                  <details open={data.sessions.length === 0 ? true : undefined}>
                    <summary>처음 사용하는 순서</summary>
                    <ol>
                      <li>
                        대상 앱의 개발 서버를 실행하고 프로젝트 설정의 시작
                        URL을 확인하세요.
                      </li>
                      <li>
                        QA 기록에서 시작을 누른 뒤, 열린 전용 브라우저에서
                        조작하세요.
                      </li>
                      <li>
                        문제나 검증 지점을 표시하고 기대 결과를 입력한 뒤 기록을
                        종료하세요.
                      </li>
                      <li>
                        시나리오 초안을 검토·재실행하고, 보고서에서 근거를
                        확인해 내보내세요.
                      </li>
                    </ol>
                    <p>
                      처음에는 개발용 데이터로 짧은 조작 하나를 기록하세요. 기록
                      종료만으로 검증 완료가 되지는 않습니다.
                    </p>
                    <button onClick={() => setTab("sessions")}>
                      QA 기록으로 이동
                    </button>
                  </details>
                  {!data.workItems.length ? (
                    <Empty
                      title="아직 정의한 작업이 없습니다."
                      text="작업을 만들거나, QA 기록부터 시작한 뒤 연결할 수 있습니다."
                    />
                  ) : (
                    data.workItems.map((w) => (
                      <article className="work-row" key={w.id}>
                        <div>
                          <span className="eyebrow">
                            WORK ITEM · {short(w.id)}
                          </span>
                          <h2>{w.title}</h2>
                          <p>{w.requirement || "요구사항 미입력"}</p>
                          <ul>
                            {w.criteria.map((c, i) => (
                              <li key={i}>{c}</li>
                            ))}
                          </ul>
                        </div>
                        <div className="work-inspector">
                          <Status
                            value={
                              data.gates[w.id]?.complete
                                ? "passed"
                                : "manual-required"
                            }
                          />
                          {data.gates[w.id]?.checks.map((c) => (
                            <p key={c.label}>
                              {c.label}
                              <span className="right">{c.status}</span>
                            </p>
                          ))}
                          {data.gates[w.id]?.reasons.map((r) => (
                            <p className="muted" key={r}>
                              ○ {r}
                            </p>
                          ))}
                          <div className="button-row">
                            <button onClick={() => openWork(w)}>
                              기준·검사 연결
                            </button>
                            <button
                              onClick={() =>
                                setModal(
                                  <ReviewForm
                                    onCancel={() => setModal(undefined)}
                                    onSave={(input) =>
                                      act(async () => {
                                        await api(
                                          base +
                                            "/work-items/" +
                                            w.id +
                                            "/reviews",
                                          input,
                                        );
                                        setModal(undefined);
                                      })
                                    }
                                  />,
                                )
                              }
                            >
                              리뷰 남기기
                            </button>
                          </div>
                        </div>
                      </article>
                    ))
                  )}
                  <section className="section">
                    <h2>등록된 검사</h2>
                    {!project?.commands.length ? (
                      <p className="muted">
                        프로젝트 연결 시 기존 검사 명령을 등록할 수 있습니다.
                      </p>
                    ) : (
                      project.commands.map((c) => (
                        <div className="list-row" key={c.id}>
                          <div>
                            <strong>{c.label}</strong>
                            <small>
                              {c.program} {c.args.join(" ")}
                            </small>
                          </div>
                          <button
                            disabled={busy}
                            onClick={() => void run("command", c.id)}
                          >
                            검사 실행 →
                          </button>
                        </div>
                      ))
                    )}
                  </section>
                </>
              )}
              {tab === "sessions" && (
                <>
                  <p className="intro">
                    전용 브라우저에서 평소처럼 조작하세요. 브라우저 상단에서
                    문제와 검증 지점을 표시할 수 있습니다.
                  </p>
                  <details className="section">
                    <summary>기록 범위와 시작 상태</summary>
                    <p>
                      클릭·입력·선택·체크·키보드·페이지 이동·탭을 기록합니다.
                      Canvas·드래그·프레임·비밀 입력은 수동 확인으로 남습니다.
                      파일 업로드는 프로젝트 설정의 테스트 파일 ID를 단계에
                      연결하세요.
                    </p>
                    <p>
                      브라우저 준비 상태:{" "}
                      {data.preparation.browserState
                        ? "비공개 저장 상태 사용"
                        : "새 상태"}{" "}
                      · 서버 로그:{" "}
                      {data.preparation.serverLogs
                        ? `${data.preparation.serverLogs}개 연결`
                        : "미연결"}{" "}
                      · 네트워크 본문: 수집하지 않음
                    </p>
                    <p>
                      브라우저 저장 상태는 쿠키·localStorage·IndexedDB만
                      준비합니다. 서버 DB와 외부 서비스 상태는 복원하지
                      않습니다.
                    </p>
                    {activeSession && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act(
                            () =>
                              api(
                                base +
                                  "/sessions/" +
                                  activeSession.id +
                                  "/browser-state",
                                {},
                              ),
                            "현재 브라우저 상태를 비공개 준비 자료로 저장했습니다. 보고서에는 포함하지 않습니다.",
                          )
                        }
                      >
                        현재 브라우저 상태를 다음 실행의 준비 자료로 저장
                      </button>
                    )}
                  </details>
                  <div className="split">
                    <div>
                      <h2 className="section-label">세션</h2>
                      {[...data.sessions].reverse().map((s) => (
                        <button
                          key={s.id}
                          aria-pressed={s.id === sessionId}
                          className={
                            "session-row " +
                            (s.id === sessionId ? "selected" : "")
                          }
                          onClick={() => setSessionId(s.id)}
                        >
                          <Status value={s.status} />
                          <strong>{time(s.startedAt)}</strong>
                          <small>
                            {s.eventCount}개 이벤트 ·{" "}
                            {short(s.code.fingerprint)}
                          </small>
                        </button>
                      ))}
                      {!data.sessions.length && (
                        <Empty
                          title="첫 QA를 기록하세요."
                          text="개인 브라우저와 분리된 환경에서 시작합니다."
                        />
                      )}
                    </div>
                    <div>
                      {sessionId ? (
                        <>
                          <div className="section-title">
                            <h2>조작 타임라인</h2>
                            <div className="button-row">
                              <button onClick={() => openFinding()}>
                                ＋ 발견 기록
                              </button>
                              <button
                                disabled={
                                  data.sessions.find((s) => s.id === sessionId)
                                    ?.status === "recording"
                                }
                                onClick={() =>
                                  void act(async () => {
                                    await api(base + "/scenarios", {
                                      sessionId,
                                      name:
                                        "QA 시나리오 " +
                                        new Date().toLocaleDateString("ko-KR"),
                                      workItemId: workId || undefined,
                                    });
                                    setTab("scenarios");
                                  }, "테스트 초안을 만들었습니다. 기대 결과를 검토하세요.")
                                }
                              >
                                시나리오 초안 →
                              </button>
                            </div>
                          </div>
                          <div className="timeline">
                            {events.map((e) => (
                              <div
                                className={"timeline-event " + e.kind}
                                key={e.id}
                              >
                                <span className="event-index">
                                  {String(e.seq).padStart(2, "0")}
                                </span>
                                <div>
                                  <strong>
                                    {e.kind === "action"
                                      ? String(e.data.type)
                                      : e.kind === "marker"
                                        ? String(e.data.title)
                                        : e.kind}
                                  </strong>
                                  <p>
                                    {String(
                                      e.data.detail ||
                                        e.data.text ||
                                        e.data.url ||
                                        e.data.value ||
                                        e.data.expected ||
                                        "",
                                    )}
                                  </p>
                                  {!!e.data.locator && (
                                    <code>
                                      {JSON.stringify(e.data.locator)}
                                    </code>
                                  )}
                                  <small>
                                    {e.pageId} ·{" "}
                                    {new Date(e.at).toLocaleTimeString("ko-KR")}
                                  </small>
                                </div>
                              </div>
                            ))}
                          </div>
                        </>
                      ) : (
                        <Empty
                          title="세션을 선택하세요."
                          text="원본 기록은 편집하지 않고 재현 절차를 별도로 만듭니다."
                        />
                      )}
                    </div>
                  </div>
                  <section className="section">
                    <h2>발견 사항</h2>
                    {data.findings.map((f) => (
                      <div className="finding-row" key={f.id}>
                        <Status value={f.status} />
                        <div>
                          <strong>{f.title}</strong>
                          <p>
                            기대: {f.expected || "미입력"} · 실제:{" "}
                            {f.actual || "미입력"}
                          </p>
                        </div>
                        <button onClick={() => openFinding(f)}>
                          검토·수정
                        </button>
                      </div>
                    ))}
                  </section>
                </>
              )}
              {tab === "scenarios" && (
                <>
                  <p className="intro">
                    조작 재생과 기대 결과 검증은 다릅니다. 초안을 확인하고,
                    재실행 근거와 함께 등록하세요.
                  </p>
                  {!data.scenarios.length && (
                    <Empty
                      title="등록할 시나리오가 없습니다."
                      text="종료한 QA 세션에서 시나리오 초안을 만드세요."
                    />
                  )}
                  {data.scenarios.map((s) => (
                    <article className="scenario-row" key={s.id}>
                      <div>
                        <Status value={s.status} />
                        <h2>{s.name}</h2>
                        <p>
                          {s.steps.length}개 조작 · {s.assertions.length}개 기대
                          결과 · v{s.version}
                        </p>
                        <small>
                          {s.prerequisites || "새 브라우저 context에서 시작"}
                        </small>
                      </div>
                      <div className="button-row">
                        <button onClick={() => openScenario(s)}>
                          단계·기대 결과
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => void run("scenario", s.id)}
                        >
                          재실행
                        </button>
                        <button
                          onClick={() =>
                            setModal(
                              <RegisterForm
                                runs={data.runs.filter(
                                  (r) =>
                                    r.targetId === s.id &&
                                    r.scenarioVersion === s.version,
                                )}
                                onCancel={() => setModal(undefined)}
                                onSave={(input) =>
                                  act(async () => {
                                    await api(
                                      base + "/scenarios/" + s.id + "/register",
                                      input,
                                    );
                                    setModal(undefined);
                                  })
                                }
                              />,
                            )
                          }
                        >
                          등록 검토
                        </button>
                        <button
                          onClick={() =>
                            void act(async () => {
                              const r = await fetch(
                                "/api/v1" +
                                  base +
                                  "/scenarios/" +
                                  s.id +
                                  "/source",
                              );
                              if (!r.ok)
                                throw new Error((await r.json()).error);
                              download(
                                "scenario-" + short(s.id) + ".spec.ts",
                                await r.text(),
                              );
                            }, "Playwright 테스트를 내려받았습니다.")
                          }
                        >
                          코드 내보내기
                        </button>
                      </div>
                    </article>
                  ))}
                </>
              )}
              {tab === "runs" && (
                <>
                  <p className="intro">
                    모든 시도를 보존합니다. 같은 코드 상태에서 실행된 결과인지
                    확인하세요.
                  </p>
                  {!data.runs.length && (
                    <Empty
                      title="아직 실행 결과가 없습니다."
                      text="등록된 검사 또는 시나리오를 실행하세요."
                    />
                  )}
                  {[...data.runs].reverse().map((r) => (
                    <article className="run-row" key={r.id}>
                      <div className="section-title">
                        <div>
                          <Status value={r.status} />
                          <h2>
                            {r.kind === "scenario"
                              ? data.scenarios.find((s) => s.id === r.targetId)
                                  ?.name
                              : project?.commands.find(
                                  (c) => c.id === r.targetId,
                                )?.label}
                          </h2>
                          <small>
                            {time(r.createdAt)} · {short(r.code.fingerprint)}{" "}
                            {r.code.fingerprint !== data.code.fingerprint
                              ? "· 이전 코드 상태"
                              : ""}
                          </small>
                        </div>
                        {["queued", "running"].includes(r.status) && (
                          <button
                            onClick={() =>
                              void act(
                                () =>
                                  api(base + "/runs/" + r.id + "/cancel", {}),
                                "취소를 요청했습니다.",
                              )
                            }
                          >
                            실행 취소
                          </button>
                        )}
                      </div>
                      <p className="run-detail">{r.detail}</p>
                      <details>
                        <summary>단계와 근거 보기</summary>
                        {r.steps.map((s) => (
                          <p key={s.index}>
                            {s.index + 1}. {s.detail} · {s.status}
                          </p>
                        ))}
                        {r.evidenceIds.map((id) => (
                          <a
                            className="evidence-link"
                            href={"/api/v1" + base + "/evidence/" + id}
                            target="_blank"
                            rel="noreferrer"
                            key={id}
                          >
                            {data.evidence.find((e) => e.id === id)?.name} ↗
                          </a>
                        ))}
                      </details>
                      {r.status === "manual-required" && (
                        <button
                          onClick={() =>
                            setModal(
                              <ManualForm
                                run={r}
                                scenario={data.scenarios.find(
                                  (s) => s.id === r.targetId,
                                )!}
                                onCancel={() => setModal(undefined)}
                                onSave={(input) =>
                                  act(async () => {
                                    await api(
                                      base + "/runs/" + r.id + "/manual",
                                      input,
                                    );
                                    setModal(undefined);
                                  })
                                }
                              />,
                            )
                          }
                        >
                          수동 확인 근거 남기기
                        </button>
                      )}
                      {r.manualChecks.map((m, i) => (
                        <p className="muted" key={i}>
                          수동 확인 · {m.reviewer} ·{" "}
                          {m.passed ? "통과" : "실패"} · {m.evidence}
                        </p>
                      ))}
                    </article>
                  ))}
                </>
              )}
              {tab === "reports" && (
                <>
                  <p className="intro">
                    요약부터 재현 절차, 수정 전후 결과까지. 같은 기록으로 읽기
                    좋은 보고서와 이슈 초안을 만듭니다.
                  </p>
                  <section className="report-cover">
                    <span className="eyebrow">EVIDENCE REPORT</span>
                    <h2>{project?.name}</h2>
                    <p>
                      {workId
                        ? data.workItems.find((w) => w.id === workId)?.title
                        : "프로젝트 검증 기록"}
                    </p>
                    <div className="report-numbers">
                      <div>
                        <strong>{data.workItems.length}</strong>
                        <span>작업</span>
                      </div>
                      <div>
                        <strong>
                          {
                            data.findings.filter((f) => f.status === "open")
                              .length
                          }
                        </strong>
                        <span>미해결 발견</span>
                      </div>
                      <div>
                        <strong>{data.runs.length}</strong>
                        <span>실행 기록</span>
                      </div>
                    </div>
                    <div className="button-row">
                      <a
                        className="button primary"
                        href={
                          "/api/v1" +
                          base +
                          "/report?format=html" +
                          (workId ? "&workItemId=" + workId : "")
                        }
                        target="_blank"
                        rel="noreferrer"
                      >
                        보고서 열기 ↗
                      </a>
                      <button
                        onClick={() =>
                          void act(async () => {
                            const r = await fetch(
                              "/api/v1" +
                                base +
                                "/report?format=markdown" +
                                (workId ? "&workItemId=" + workId : ""),
                            );
                            download(
                              "verification.md",
                              await r.text(),
                              "text/markdown",
                            );
                          }, "Markdown을 내려받았습니다.")
                        }
                      >
                        Markdown
                      </button>
                      <button
                        onClick={() =>
                          void act(async () => {
                            const r = await fetch(
                              "/api/v1" +
                                base +
                                "/report?format=issue" +
                                (workId ? "&workItemId=" + workId : ""),
                            );
                            await navigator.clipboard.writeText(await r.text());
                          }, "이슈 템플릿을 복사했습니다.")
                        }
                      >
                        이슈 템플릿 복사
                      </button>
                    </div>
                  </section>
                  <section className="section">
                    <h2>보고서 묶음 내보내기</h2>
                    <p className="muted">
                      첨부할 화면·로그를 먼저 확인하세요. 선택하지 않은 근거와
                      인증 상태는 포함하지 않습니다.
                    </p>
                    <div className="evidence-list">
                      {data.evidence.map((e) => (
                        <label className="check-row" key={e.id}>
                          <input
                            type="checkbox"
                            checked={selectedEvidence.includes(e.id)}
                            onChange={(ev) =>
                              setSelectedEvidence((list) =>
                                ev.target.checked
                                  ? [...list, e.id]
                                  : list.filter((i) => i !== e.id),
                              )
                            }
                          />
                          <span>{e.name}</span>
                          <a
                            href={"/api/v1" + base + "/evidence/" + e.id}
                            target="_blank"
                            rel="noreferrer"
                          >
                            미리보기 ↗
                          </a>
                        </label>
                      ))}
                    </div>
                    <form
                      className="inline-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const form = new FormData(e.currentTarget);
                        void act(async () => {
                          const r = await api<{ folder: string }>(
                            base + "/report/export",
                            {
                              destination: form.get("destination"),
                              workItemId: workId || undefined,
                              evidenceIds: selectedEvidence,
                            },
                          );
                          return "저장 위치: " + r.folder;
                        }, "보고서 묶음을 저장했습니다.");
                      }}
                    >
                      <input
                        name="destination"
                        required
                        placeholder="저장할 폴더의 절대 경로"
                        aria-label="보고서 저장 폴더"
                      />
                      <button className="primary" disabled={busy}>
                        묶음 내보내기
                      </button>
                    </form>
                  </section>
                </>
              )}
            </>
          )}
        </div>
        <footer>
          good-verify{" "}
          <span>
            기록된 범위와 근거에 한정된 검증 · 자동화 미지원 구간은 명시됩니다.
          </span>
        </footer>
      </main>
      {modal && (
        <div className="modal-backdrop" ref={dialogPresence.ref}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="편집"
          >
            {error && (
              <p role="alert" className="alert">
                {error}
              </p>
            )}
            <fieldset
              disabled={busy || dialogPresence.leaving}
              style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
            >
              {modal}
            </fieldset>
          </div>
        </div>
      )}
    </div>
  );
}
function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty">
      <span>↗</span>
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}
type FormProps = {
  onCancel: () => void;
  onSave: (input: unknown) => Promise<void>;
};
function Buttons({ onCancel }: { onCancel: () => void }) {
  return (
    <div className="form-actions">
      <button type="button" onClick={onCancel}>
        취소
      </button>
      <button className="primary" type="submit">
        저장
      </button>
    </div>
  );
}
function ProjectForm({
  onCancel,
  onSave,
  project,
}: FormProps & { project?: Project }) {
  const [err, setErr] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const [suggestions, setSuggestions] = useState<ProjectSuggestions>();
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const search = async () => {
    const form = formRef.current!;
    const root = String(new FormData(form).get("root") || "");
    setSearching(true);
    setErr("");
    setSuggestions(undefined);
    setSelected([]);
    try {
      const result = await api<ProjectSuggestions>("/project-suggestions", {
        root,
      });
      if (formRef.current === form && new FormData(form).get("root") === root)
        setSuggestions(result);
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setSearching(false);
    }
  };
  return (
    <form
      ref={formRef}
      onSubmit={(e) => {
        e.preventDefault();
        if (searching) return;
        const f = new FormData(e.currentTarget);
        try {
          const commands = JSON.parse(String(f.get("commands") || "[]"));
          if (!Array.isArray(commands))
            throw new Error("commands must be an array");
          for (const suggestion of suggestions?.commands || []) {
            if (
              !selected.includes(suggestion.id) ||
              commands.some(
                (command) =>
                  command.program === suggestion.program &&
                  JSON.stringify(command.args) ===
                    JSON.stringify(suggestion.args),
              )
            )
              continue;
            let id = suggestion.id;
            while (commands.some((command) => command.id === id)) id += "_new";
            commands.push({ ...suggestion, id });
          }
          void onSave({
            name: f.get("name"),
            root: f.get("root"),
            baseUrl: f.get("baseUrl"),
            commands,
            prepareCommandId: f.get("prepare") || undefined,
            files: JSON.parse(String(f.get("files") || "{}")),
            logFiles: String(f.get("logFiles") || "")
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
          });
        } catch {
          setErr("검사 명령 JSON을 확인하세요.");
        }
      }}
    >
      <span className="eyebrow">CONNECT PROJECT</span>
      <h2>프로젝트 연결</h2>
      <p>설정과 QA 기록은 제품 저장소 밖에 분리해서 보관합니다.</p>
      <Field label="표시 이름">
        <input
          name="name"
          required
          placeholder="내 프로젝트"
          defaultValue={project?.name}
        />
      </Field>
      <Field label="프로젝트 폴더">
        <input
          name="root"
          required
          placeholder="프로젝트의 절대 경로"
          defaultValue={project?.root}
          readOnly={!!project}
          onChange={() => {
            setSuggestions(undefined);
            setSelected([]);
          }}
        />
      </Field>
      <button type="button" disabled={searching} onClick={() => void search()}>
        {searching ? "설정 찾는 중…" : "프로젝트 설정 찾기"}
      </button>
      <p>
        폴더의 package.json을 읽습니다. 파일을 수정하거나 명령을 실행하지
        않습니다.
      </p>
      {suggestions && (
        <section aria-label="찾은 설정">
          <h3>찾은 설정 — 확인 후 선택하세요</h3>
          {suggestions.startHint && (
            <p>
              개발 서버 실행: <code>{suggestions.startHint}</code>
            </p>
          )}
          {suggestions.baseUrl && (
            <p>
              예상 주소: <code>{suggestions.baseUrl}</code>{" "}
              <button
                type="button"
                onClick={() => {
                  const input = formRef.current!.elements.namedItem(
                    "baseUrl",
                  ) as HTMLInputElement;
                  input.value = suggestions.baseUrl!;
                  input.focus();
                }}
              >
                제안 URL 사용
              </button>
            </p>
          )}
          {suggestions.commands.length === 0 && (
            <p>
              자동으로 찾은 검사가 없습니다. QA 기록만으로 시작할 수 있습니다.
            </p>
          )}
          {suggestions.commands.map((command) => (
            <label className="check-row" key={command.id}>
              <input
                type="checkbox"
                checked={selected.includes(command.id)}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, command.id]
                      : current.filter((id) => id !== command.id),
                  )
                }
              />
              검사 연결: {command.program} {command.args.join(" ")}
            </label>
          ))}
          {suggestions.notes.map((note) => (
            <p key={note} className="muted">
              {note}
            </p>
          ))}
        </section>
      )}
      <Field label="시작 URL">
        <input
          name="baseUrl"
          type="url"
          required
          defaultValue={project?.baseUrl || "http://127.0.0.1:3000"}
        />
      </Field>
      <details>
        <summary>기존 검사·준비 명령 연결</summary>
        <Field label="검사 명령 JSON">
          <textarea
            name="commands"
            rows={5}
            defaultValue={JSON.stringify(project?.commands || [], null, 2)}
            placeholder={
              '[{"id":"test","label":"테스트","program":"pnpm","args":["test"]}]'
            }
          />
        </Field>
        <Field label="준비 명령 ID (선택)">
          <input
            name="prepare"
            placeholder="등록된 검사 ID"
            defaultValue={project?.prepareCommandId}
          />
        </Field>
        <Field label="테스트 파일 연결 JSON (ID: 상대 경로)">
          <textarea
            name="files"
            defaultValue={JSON.stringify(project?.files || {}, null, 2)}
          />
        </Field>
        <Field label="서버 로그 상대 경로 (한 줄에 하나)">
          <textarea
            name="logFiles"
            defaultValue={project?.logFiles?.join("\n")}
          />
        </Field>
        <p className="muted">
          명령은 연결한 프로젝트 폴더에서 실행됩니다. 신뢰하는 명령만
          등록하세요.
        </p>
      </details>
      {err && <p role="alert">{err}</p>}
      <Buttons onCancel={onCancel} />
    </form>
  );
}
function WorkForm({
  data,
  item,
  onCancel,
  onSave,
}: FormProps & { data: Snapshot; item?: WorkItem }) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void onSave({
          title: f.get("title"),
          requirement: f.get("requirement"),
          criteria: String(f.get("criteria"))
            .split("\n")
            .filter((x) => x.trim()),
          requiredCommandIds: f.getAll("commands"),
          requiredScenarioIds: f.getAll("scenarios"),
        });
      }}
    >
      <h2>{item ? "작업 기준 수정" : "검증할 작업 만들기"}</h2>
      <Field label="작업 이름">
        <input name="title" required defaultValue={item?.title} />
      </Field>
      <Field label="요구사항 또는 문서 참조">
        <textarea name="requirement" defaultValue={item?.requirement} />
      </Field>
      <Field label="완료 기준 (한 줄에 하나)">
        <textarea
          name="criteria"
          rows={4}
          defaultValue={item?.criteria.join("\n")}
          placeholder="취소 후 다시 열면 이전에 저장한 값이 표시된다."
        />
      </Field>
      <h3>필수 검사</h3>
      {data.project.commands.map((c) => (
        <label className="check-row" key={c.id}>
          <input
            type="checkbox"
            name="commands"
            value={c.id}
            defaultChecked={item?.requiredCommandIds.includes(c.id)}
          />
          {c.label}
        </label>
      ))}
      <h3>필수 시나리오</h3>
      {data.scenarios.map((s) => (
        <label className="check-row" key={s.id}>
          <input
            type="checkbox"
            name="scenarios"
            value={s.id}
            defaultChecked={item?.requiredScenarioIds.includes(s.id)}
          />
          {s.name}
        </label>
      ))}
      <Buttons onCancel={onCancel} />
    </form>
  );
}
function FindingForm({
  finding,
  sessionId,
  workId,
  onCancel,
  onSave,
}: FormProps & { finding?: Finding; sessionId: string; workId: string }) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void onSave({
          ...Object.fromEntries(f),
          sessionId: finding?.sessionId || sessionId,
          workItemId: workId || finding?.workItemId,
          blocking: f.get("blocking") === "on",
          resolutionRunId: f.get("resolutionRunId") || undefined,
        });
      }}
    >
      <h2>발견 사항</h2>
      {[
        ["title", "제목"],
        ["expected", "기대 결과"],
        ["actual", "실제 결과"],
        ["facts", "확인된 사실"],
        ["hypothesis", "원인 가설"],
        ["confirmedCause", "확인된 원인"],
      ].map(([key, label]) => (
        <Field label={label} key={key}>
          <textarea
            name={key}
            required={key === "title"}
            defaultValue={finding?.[key as keyof Finding] as string}
            rows={key === "title" ? 1 : 2}
          />
        </Field>
      ))}
      <label className="check-row">
        <input
          type="checkbox"
          name="blocking"
          defaultChecked={finding?.blocking ?? true}
        />
        완료를 막는 문제
      </label>
      {finding && (
        <Field label="해결을 확인한 통과 실행 ID (선택)">
          <input
            name="resolutionRunId"
            defaultValue={finding.resolutionRunId}
          />
        </Field>
      )}
      <Buttons onCancel={onCancel} />
    </form>
  );
}
function ScenarioForm({
  scenario,
  onCancel,
  onSave,
}: FormProps & { scenario: Scenario }) {
  const [assertions, setAssertions] = useState<Assertion[]>(
      scenario.assertions,
    ),
    [err, setErr] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        try {
          void onSave({
            name: f.get("name"),
            prerequisites: f.get("prerequisites"),
            steps: JSON.parse(String(f.get("steps"))),
            assertions,
            workItemId: scenario.workItemId,
          });
        } catch {
          setErr("단계 JSON을 확인하세요.");
        }
      }}
    >
      <h2>단계와 기대 결과</h2>
      <Field label="시나리오 이름">
        <input name="name" required defaultValue={scenario.name} />
      </Field>
      <Field label="시작 조건 / 준비 절차">
        <textarea name="prerequisites" defaultValue={scenario.prerequisites} />
      </Field>
      <h3>기대 결과</h3>
      {assertions.map((a, i) => (
        <div className="assertion" key={a.id}>
          <select
            aria-label="검증 종류"
            value={a.kind}
            onChange={(e) =>
              setAssertions((list) =>
                list.map((v, j) =>
                  j === i
                    ? { ...v, kind: e.target.value as Assertion["kind"] }
                    : v,
                ),
              )
            }
          >
            {[
              ["visible", "표시됨"],
              ["hidden", "숨김"],
              ["text", "텍스트"],
              ["value", "입력값"],
              ["count", "개수"],
              ["url", "URL"],
              ["manual", "수동 확인"],
            ].map(([v, t]) => (
              <option key={v} value={v}>
                {t}
              </option>
            ))}
          </select>
          <input
            aria-label="기대 결과"
            placeholder="기대 결과"
            value={a.expected}
            onChange={(e) =>
              setAssertions((list) =>
                list.map((v, j) =>
                  j === i ? { ...v, expected: e.target.value } : v,
                ),
              )
            }
          />
          <input
            aria-label="요소 label 또는 접근성 이름"
            placeholder="요소의 label / aria-label"
            value={a.locator?.value || ""}
            onChange={(e) =>
              setAssertions((list) =>
                list.map((v, j) =>
                  j === i
                    ? {
                        ...v,
                        locator: { kind: "label", value: e.target.value },
                      }
                    : v,
                ),
              )
            }
          />
          <button
            type="button"
            onClick={() =>
              setAssertions((list) => list.filter((_, j) => i !== j))
            }
          >
            제거
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          setAssertions((list) => [
            ...list,
            {
              id: crypto.randomUUID(),
              kind: "text",
              pageId: "page-1",
              expected: "",
            },
          ])
        }
      >
        ＋ 기대 결과 추가
      </button>
      <details>
        <summary>고급: 원본에서 파생한 재현 단계</summary>
        <Field label="단계 JSON">
          <textarea
            name="steps"
            rows={12}
            defaultValue={JSON.stringify(scenario.steps, null, 2)}
          />
        </Field>
      </details>
      {err && <p>{err}</p>}
      <Buttons onCancel={onCancel} />
    </form>
  );
}
function ReviewForm({ onCancel, onSave }: FormProps) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void onSave({
          reviewer: f.get("reviewer"),
          verdict: f.get("verdict"),
          evidence: f.get("evidence"),
          independent: f.get("independent") === "on",
        });
      }}
    >
      <h2>현재 코드 리뷰</h2>
      <Field label="검토자">
        <input name="reviewer" required />
      </Field>
      <Field label="판정">
        <select name="verdict">
          <option value="approved">승인</option>
          <option value="changes-requested">수정 필요</option>
        </select>
      </Field>
      <Field label="검토 범위와 근거">
        <textarea name="evidence" required rows={4} />
      </Field>
      <label className="check-row">
        <input type="checkbox" name="independent" />
        작성자와 다른 사람이 독립적으로 검토함
      </label>
      <Buttons onCancel={onCancel} />
    </form>
  );
}
function RegisterForm({ runs, onCancel, onSave }: FormProps & { runs: Run[] }) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(Object.fromEntries(new FormData(e.currentTarget)));
      }}
    >
      <h2>시나리오 등록 검토</h2>
      <p>현재 버전의 실행 결과와 기대 결과를 확인한 뒤 등록합니다.</p>
      <Field label="검토자">
        <input name="reviewer" required />
      </Field>
      <Field label="근거 실행">
        <select name="runId" required>
          {[...runs].reverse().map((r) => (
            <option value={r.id} key={r.id}>
              {labels[r.status]} · {time(r.createdAt)}
            </option>
          ))}
        </select>
      </Field>
      <Buttons onCancel={onCancel} />
    </form>
  );
}
function ManualForm({
  scenario,
  onCancel,
  onSave,
}: FormProps & { run: Run; scenario: Scenario }) {
  const options =
    scenario.steps.some((s) => s.type === "manual") ||
    !scenario.assertions.length
      ? [{ id: "manual-flow", expected: "자동화되지 않은 전체 흐름" }]
      : scenario.assertions.filter((a) => a.kind === "manual");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void onSave({
          ...Object.fromEntries(f),
          passed: f.get("passed") === "true",
        });
      }}
    >
      <h2>수동 검증 근거</h2>
      <Field label="확인할 항목">
        <select name="assertionId">
          {options.map((a) => (
            <option value={a.id} key={a.id}>
              {a.expected}
            </option>
          ))}
        </select>
      </Field>
      <Field label="검증자">
        <input name="reviewer" required />
      </Field>
      <Field label="결과">
        <select name="passed">
          <option value="true">통과</option>
          <option value="false">실패</option>
        </select>
      </Field>
      <Field label="실행 조건·기대값·실제값·근거">
        <textarea name="evidence" required rows={5} />
      </Field>
      <Buttons onCancel={onCancel} />
    </form>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
