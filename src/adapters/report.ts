import type { ProjectData, CodeState } from "../core/model.js";
import { completionGate, labels } from "../core/model.js";
import { redact, redactData } from "../core/redaction.js";
export const escapeHtml = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function createReport(
  data: ProjectData,
  code: CodeState,
  workItemId?: string,
) {
  const items = data.workItems.filter(
    (w) => !workItemId || w.id === workItemId,
  );
  const findings = data.findings.filter(
    (f) => !workItemId || f.workItemId === workItemId,
  );
  const runs = data.runs.filter(
    (r) => !workItemId || r.workItemId === workItemId,
  );
  return redactData({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    project: { id: data.project.id, name: data.project.name },
    code,
    scope: workItemId ? "작업 검증" : "프로젝트 검증",
    workItems: items.map((item) => ({
      ...item,
      gate: completionGate(data, item, code),
    })),
    findings,
    scenarios: data.scenarios.filter(
      (s) => !workItemId || s.workItemId === workItemId,
    ),
    runs,
    evidence: data.evidence
      .filter(
        (e) =>
          runs.some((r) => r.evidenceIds.includes(e.id)) ||
          findings.some((f) => f.evidenceIds.includes(e.id)),
      )
      .map(({ relativePath, ...e }) => e),
    limitations: [
      "기록된 조건과 명시한 기대 결과에 한정된 검증입니다.",
      "서버·외부 서비스·실시간 이벤트는 브라우저 상태와 별도로 준비해야 합니다.",
      "네트워크 본문·인증 상태·비밀 입력은 보고서에 포함하지 않습니다.",
    ],
  });
}
export type Report = ReturnType<typeof createReport>;
export function markdownReport(r: Report) {
  const lines = [
    `# ${r.project.name} — 검증 보고서`,
    "",
    `- 생성: ${r.generatedAt}`,
    `- 범위: ${r.scope}`,
    `- 코드: ${r.code.revision}${r.code.dirty ? " (미커밋 변경 포함)" : ""}`,
    `- 상태 식별자: ${r.code.fingerprint}`,
    "",
    "## 결론",
  ];
  if (!r.workItems.length)
    lines.push(
      "완료 기준이 연결된 작업이 없습니다. 프로젝트 전체 검증 완료를 의미하지 않습니다.",
    );
  for (const w of r.workItems) {
    lines.push(
      `### ${w.title}`,
      w.gate.complete ? "검증 완료" : "미완료",
      `요구사항: ${w.requirement}`,
      ...w.criteria.map((c) => `- 완료 기준: ${c}`),
      ...w.gate.reasons.map((x) => `- 남은 확인: ${x}`),
      "",
    );
    for (const review of w.reviews)
      lines.push(
        `- 리뷰: ${review.reviewer} / ${review.verdict} / ${review.independent ? "독립 리뷰로 등록" : "본인·일반 리뷰"} / ${review.at}`,
        `  근거: ${review.evidence}`,
      );
  }
  lines.push("", "## 발견 사항");
  for (const f of r.findings)
    lines.push(
      `### ${f.title}`,
      `- 상태: ${f.status}`,
      `- 기대 결과: ${f.expected || "미입력"}`,
      `- 실제 결과: ${f.actual || "미입력"}`,
      `- 확인된 사실: ${f.facts || "미기록"}`,
      `- 원인 가설: ${f.hypothesis || "미확정"}`,
      `- 확인된 원인: ${f.confirmedCause || "미확정"}`,
      `- 근거 ID: ${f.evidenceIds.join(", ") || "없음"}`,
      `- 해결 검증: ${f.resolutionRunId || "미연결"}`,
      "",
    );
  lines.push("## 재현 절차");
  for (const s of r.scenarios) {
    lines.push(
      `### ${s.name} (v${s.version}, ${s.status})`,
      `시작 조건: ${s.prerequisites || "새 브라우저 context와 프로젝트 시작 URL"}`,
      ...s.steps.map(
        (a, i) =>
          `${i + 1}. ${a.type} ${a.locator ? JSON.stringify(a.locator) : ""} ${a.value ?? a.url ?? a.detail ?? ""}`,
      ),
      "기대 결과:",
      ...s.assertions.map((a) => `- ${a.kind}: ${a.expected}`),
      "",
    );
  }
  lines.push("## 실행 이력");
  for (const run of r.runs)
    lines.push(
      `### ${run.id}`,
      `- 결과: ${labels[run.status]}`,
      `- 코드 상태: ${run.code.fingerprint}`,
      `- 시나리오 버전: ${run.scenarioVersion ?? "해당 없음"}`,
      `- 실행: ${run.createdAt}`,
      `- 상세: ${run.detail}`,
      ...run.steps.map(
        (s) => `- 단계 ${s.index + 1}: ${s.status} — ${s.detail}`,
      ),
      ...(run.scenarioSnapshot
        ? [
            "- 당시 테스트 정의:",
            ...run.scenarioSnapshot.steps.map(
              (s, i) => `  ${i + 1}. ${JSON.stringify(s)}`,
            ),
            ...run.scenarioSnapshot.assertions.map(
              (a) => `  기대 결과: ${JSON.stringify(a)}`,
            ),
          ]
        : []),
      ...run.manualChecks.map(
        (m) =>
          `- 수동 확인: ${m.reviewer} / ${m.passed ? "통과" : "실패"} / ${m.evidence}`,
      ),
      "",
    );
  lines.push(
    "## 미검증 사항과 한계",
    ...r.limitations.map((l) => "- " + l),
    "",
    "## 첨부 근거",
    ...r.evidence.map((e) => `- ${e.name} (${e.id})`),
  );
  return redact(lines.join("\n"));
}
export function htmlReport(r: Report) {
  const text = markdownReport(r);
  // A deliberately small renderer: text is escaped before any markup is added.
  // No raw HTML, images, links, or scripts from project strings are interpreted.
  const body = text
    .split("\n")
    .map((line) => {
      const heading = /^(#{1,3}) (.*)$/.exec(line);
      if (heading)
        return `<h${heading[1].length}>${escapeHtml(heading[2])}</h${heading[1].length}>`;
      if (!line) return "";
      return `<p${line.startsWith("- ") ? ' class="item"' : ""}>${escapeHtml(line)}</p>`;
    })
    .join("\n");
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:"><title>${escapeHtml(r.project.name)} — 검증 보고서</title><style>body{margin:0;background:#f8f8f8;color:#313131;font:16px/1.75 'Segoe UI','Malgun Gothic',sans-serif}main{max-width:900px;margin:auto;padding:48px 24px}header{color:#5f5f5f;font-size:12px}h1{font-size:30px;line-height:1.4}h2{font-size:22px;margin-top:40px;padding-bottom:12px;border-bottom:1px solid #e0e0e0}h3{font-size:18px;margin-top:28px}p{margin:6px 0;white-space:pre-wrap;overflow-wrap:anywhere}.item{padding-left:12px}a{color:#5a5a5a}.evidence{padding:16px 0;border-bottom:1px solid #e0e0e0}img{display:block;max-width:100%;margin-top:12px}@media print{body{background:white}h2,h3{break-after:avoid}img{max-height:600px;object-fit:contain}}</style><main><header>good-verify / 검증 기록</header>${body}${r.evidence
    .map((e) => {
      const link = `evidence/${escapeHtml(e.id)}${e.mime === "image/png" ? ".png" : ".txt"}`;
      return `<section class="evidence"><a href="${link}">${escapeHtml(e.name)}</a>${e.mime === "image/png" ? `<img src="${link}" alt="${escapeHtml(e.name)}">` : ""}</section>`;
    })
    .join("")}</main></html>`;
}
export function issueTemplate(r: Report) {
  return [
    "# 문제 / 검증 결과",
    "",
    "## 요약",
    ...r.findings.map((f) => `- ${f.title}`),
    "",
    "## 기대 결과",
    ...r.findings.map((f) => `- ${f.expected}`),
    "",
    "## 실제 결과",
    ...r.findings.map((f) => `- ${f.actual}`),
    "",
    "## 재현·환경·수정 전후 근거",
    "아래 보고서에서 필요한 내용을 선택하고 첨부 자료의 민감정보를 확인하세요.",
    "",
    markdownReport(r),
  ].join("\n");
}
