# HTTP API와 CLI

## 인증

서버는 기본 `http://127.0.0.1:4318`에서 실행한다. 자동화 클라이언트는 OS 데이터 디렉터리의 `runtime.json`을 **프로그램 안에서** 읽고 `Authorization: Bearer <token>`을 전송한다. 파일 내용이나 토큰을 로그·채팅·CI artifact에 출력하지 않는다.

UI는 서빙된 `index.html`에 실린 1회용 nonce로 세션을 시작하고, 이후 HttpOnly 쿠키를 사용한다. 쿠키 값은 API 토큰이 아니라 서버가 보관하는 별도의 세션 식별자이며 Bearer 토큰으로 재사용할 수 없다. 쿠키는 포트를 구분하지 못하므로 토큰 자체를 쿠키에 넣지 않는다. 헤더만 맞춘 요청은 nonce가 없으면 세션을 받지 못한다. `--dev`에서는 UI를 Vite가 서빙해 nonce를 실을 수 없어 이 검사를 적용하지 않으며, Host와 Origin 허용 범위도 `127.0.0.1:5173`까지 넓어진다. 개발 전용 완화이므로 기본 실행 경로에는 해당하지 않는다.

등록된 명령은 사용자가 승인한 신뢰 경계다. 페이지 내용이나 AI가 생성한 자연어를 실행 요청의 명령으로 받지 않는다. 원격 클라이언트에 서버를 노출하지 않는다.

## 리소스

접두사 `/api/v1`. 아래 `P`, `W`, `S`, `F`, `R`은 해당 프로젝트 안의 UUID다. 요청·응답은 별도 표기가 없으면 JSON이다. 잘못된 입력은 오류이며 자동 보정해 실행하지 않는다.

| Method / path                             | 역할                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| GET /projects                             | 연결 프로젝트 목록                                                           |
| POST /projects                            | name, root, baseUrl, commands, prepareCommandId, files, logFiles 등록        |
| GET /projects/P                           | 현재 코드·작업·세션·발견·시나리오·실행·완료 판정                             |
| PUT /projects/P                           | 연결 설정 변경. 실행 중 변경과 root 교체는 거부                              |
| GET /projects/P/config                    | 공유 설정. 로컬 명령 경로·인증 문자열이 있으면 거부                          |
| POST /projects/P/work-items               | 요구사항·완료 기준·필수 검사 등록                                            |
| PUT /projects/P/work-items/W              | 기준 수정, 버전 증가                                                         |
| POST /projects/P/work-items/W/reviews     | reviewer, independent, verdict, evidence                                     |
| POST /projects/P/sessions                 | QA 시작, 선택적 workItemId                                                   |
| POST /projects/P/sessions/S/stop          | 정상 종료 요청                                                               |
| POST /projects/P/sessions/S/browser-state | 현재 전용 브라우저 상태를 비공개 준비 자료로 저장                            |
| GET /projects/P/sessions/S/events         | 원본 이벤트 목록                                                             |
| POST /projects/P/findings                 | sessionId, 제목, 기대값·실제값·사실·가설·원인                                |
| PATCH /projects/P/findings/F              | 발견 수정·작업 연결·resolutionRunId 연결                                     |
| POST /projects/P/scenarios                | sessionId에서 name, assertions, prerequisites로 초안 생성                    |
| PUT /projects/P/scenarios/S               | name, steps, assertions, prerequisites 수정                                  |
| POST /projects/P/scenarios/S/register     | reviewer, runId로 등록 검토                                                  |
| GET /projects/P/scenarios/S/source        | 독립 Playwright TypeScript 소스                                              |
| POST /projects/P/runs                     | kind: command 또는 scenario, targetId, 선택적 workItemId. 202와 실행 ID 반환 |
| POST /projects/P/runs/R/cancel            | 취소 요청                                                                    |
| POST /projects/P/runs/R/manual            | assertionId, reviewer, evidence, passed                                      |
| GET /projects/P/events                    | SSE `ready`, `change`. 변경 후 프로젝트 snapshot을 다시 조회                 |
| GET /projects/P/evidence/E                | 해당 프로젝트의 첨부                                                         |
| GET /projects/P/report                    | format: json, html, markdown, issue. 선택적 workItemId                       |
| POST /projects/P/report/export            | destination, 선택적 workItemId, evidenceIds                                  |

자유 QA 후 작업은 발견과 시나리오에 연결할 수 있다. 원본 세션은 편집하지 않는다. 실행 상태는 프로젝트 snapshot의 `runs`에서 ID로 조회한다. 실행 요청의 202는 통과가 아니다.

### 명령과 assertion 예시

```json
{
  "id": "test",
  "label": "프로젝트 테스트",
  "program": "pnpm",
  "args": ["test"],
  "timeoutMs": 120000
}
```

```json
{
  "id": "saved-title",
  "pageId": "page-1",
  "kind": "text",
  "locator": { "kind": "testId", "value": "saved-title" },
  "expected": "처음 제목",
  "afterStep": 2
}
```

`afterStep: 0`은 조작 전, 생략은 마지막 단계 후다. 지원 종류는 visible, hidden, text, value, count, url, manual이다. manual은 자유 서술 기대값이다. 수동 단계 또는 기대값 없는 흐름의 수동 확인 ID는 `manual-flow`이며 전체 흐름의 조건·기대·실제 결과를 근거로 남긴다.

## CLI

```sh
pnpm gv help
pnpm gv projects
pnpm gv connect /absolute/path/project.json
pnpm gv status --project PROJECT_ID
pnpm gv run --project PROJECT_ID --check test --work WORK_ID
pnpm gv run --project PROJECT_ID --scenario SCENARIO_ID
pnpm gv report --project PROJECT_ID --format markdown
pnpm gv serve --headless --port 4318
```

CLI도 HTTP API를 사용하므로 먼저 서비스가 실행 중이어야 한다. CI/외부 에이전트는 실행 ID로 상태를 확인하고 passed와 manual-required를 구분해야 한다. `run` 명령은 요청 후 반환하며 종료 코드가 검증 결과를 뜻하지 않는다. UI 없이 실행할 때는 serve에 `--headless`를 준다.

프로젝트 설정의 root는 연결 설정 파일 기준 상대 경로로 가져올 수 있다. 테스트 파일과 서버 로그는 프로젝트 root 안의 상대 경로만 허용한다. 준비 명령은 서버를 영구 실행하는 명령이 아니라, 완료 후 종료 코드를 반환하는 준비 작업이어야 한다.
