# 아키텍처와 검증 계약

## 책임

```text
React UI / HTTP API / CLI
          │
          ▼
      Workbench                 Application: 검증 흐름과 실행 대기열
       │      │
       ▼      ▼
      Core   Adapters           Core: 모델·입력 계약·완료 판정
             ├ Chromium         Adapters: public Playwright API
             ├ Registered jobs
             ├ JSON / JSONL
             └ Reports
```

Core에는 DOM 선택 방식의 데이터 계약은 있지만 특정 앱의 선택자·경로·업무 로직은 없다. 프로젝트는 UUID로 분리한다. 대상 폴더는 기존 명령 실행과 코드 상태 확인에 사용하며 대상의 설정 파일을 자동 수정하지 않는다.

## 저장 구조

```text
OS application data / good-verify/
  service.lock                   CLI 서비스의 중복 시작 방지
  runtime.json                   로컬 URL·접근 토큰, 공유 금지
  projects/<uuid>/
    project.json                 schemaVersion: 1
    sessions/<uuid>/events.jsonl  추가 기록, 원본 조작·오류·메모
    evidence/<uuid>.png|txt       화면·명령 출력·연결 로그
    runs/<uuid>/result.png       실행기 산출물
    private/browser-state.json   선택적 비공개 준비 상태
```

프로젝트별 메타데이터 쓰기를 직렬화하고 임시 파일을 rename하여 교체한다. JSONL이 메타데이터보다 먼저 기록된다. 복구할 때 중단 세션의 이벤트 수를 실제 로그에 맞추고, 잘린 마지막 JSONL 조각은 읽지 않는다. 중간 레코드 손상은 오류이며 성공으로 복구하지 않는다. 이 방식은 전원 손실에 대한 fsync 기반 데이터베이스 내구성을 주장하지 않는다.

## 코드 상태와 완료 판정

Git commit, dirty 상태, diff, untracked 파일 내용으로 상태 식별자를 만든다. Git이 없으면 빌드·의존성·환경 파일 등을 제외한 파일 내용을 해시한다. 프로젝트 URL·명령·파일 연결 및 저장된 브라우저 상태의 해시도 판정에 반영한다.

환경 변수, ignored 파일, 서버 DB, 시간·난수·외부 서비스 변경 전체를 추적하지는 않는다. 필요한 조건을 시나리오의 준비 절차에 명시해야 한다. 해시가 같다는 사실은 외부 세계가 동일하다는 증거가 아니다.

작업 완료에는 요구사항, 완료 기준, 필수 검사/등록 시나리오의 현재 코드 결과, 모든 수동 확인 근거, 차단 중인 발견 없음, 현재 기준 버전·코드의 리뷰 승인이 필요하다. 본인 리뷰는 허용하지만 독립 리뷰로 자동 표시하지 않는다. 최신 재시도가 실패하면 이전 통과로 덮지 않는다.

실행은 당시 시나리오 정의를 snapshot으로 보존한다. 초안 수정은 버전을 높이고 등록 상태를 해제한다. 발견을 해결할 때 같은 원본 세션에서 파생한 시나리오의 현재 코드 통과 실행을 요구한다. 이는 사람의 원인 분석을 대신하지 않는다.

## 기록과 재현

`BrowserContext.addInitScript`와 `exposeBinding`, page 이벤트를 사용한다. 입력값은 완료된 조합 입력과 조작 순서를 고려해 수집한다. locator는 test ID·label·role/name 등을 우선하며 모호하면 임의의 첫 요소로 진행하지 않는다.

새 context에서 시작 URL을 연다. 저장 상태를 명시적으로 저장했다면 쿠키·localStorage·IndexedDB를 준비한다. 서버 상태는 등록한 준비 명령의 책임이다. 준비 명령이 실패하면 실행을 시작하지 않는다.

Canvas·드래그·프레임·비밀 입력은 수동 단계다. 자동 실행은 수동 단계에서 멈추며 남은 전체 흐름을 확인해야 한다. 기대값이 없는 기록도 수동 확인이다. 범위를 벗어난 assertion이나 중복 ID를 거부한다.

명령과 자동 시나리오는 하나의 실행 대기열을 사용한다. 명령은 program/args로 등록하고 페이지 문자열을 shell 명령으로 실행하지 않는다. 취소·타임아웃은 도구가 실행한 프로세스를 대상으로 처리한다. 전체 자동 실행 상한은 5분이며 각 명령에는 개별 제한이 있다.

## 공유

JSON 보고서 객체에서 HTML·Markdown·이슈 초안을 만든다. 이름·기대값·실제값·판정·시나리오·실행 이력을 공유하며 로컬 root나 비공개 저장 상태는 포함하지 않는다. 첨부는 사용자가 선택한 항목만 복사한다.

생성한 테스트는 `@playwright/test`만 요구한다. `BASE_URL`은 첫 시작 주소이며, 기록된 절대 이동 URL과 URL 기대값은 임의로 다른 origin에 재매핑하지 않는다. 다른 환경으로 전달할 때 이 주소도 검토해야 한다. 파일 업로드는 `GV_FILE_<ID>`, 브라우저 준비 자료는 `STORAGE_STATE`로 연결할 수 있다. 미완성 단계는 예외를 발생시키며 테스트를 조용히 통과시키지 않는다.
