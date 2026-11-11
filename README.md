# claude-graph

Claude Code용 그래프 엔지니어링 설정. 여러 에이전트가 필요한 작업을 대화로 조율하지 않고 **그래프**로 실행한다.

| 구성 요소 | 그래프에서의 의미 | Claude Code에서의 구현 |
|---|---|---|
| 노드 | 한 가지 일을 하는 에이전트 | 서브에이전트 `graph-*` (`~/.claude/agents/`) |
| 엣지 | 순차·분기·합류·조건·사이클 | Workflow 스크립트의 제어 흐름 (`~/.claude/workflows/`) |
| 상태 | 엣지를 따라 흐르는 데이터 | JSON Schema로 검증된 노드 출력 + `.claude/graph/runs/` 파일 |
| 게이트 | 다음 엣지를 정하는 판정 | 검증·리뷰·반증 노드, 계획 검증 코드, 노드 훅 |

흐름은 모델이 아니라 코드가 정한다. 모델은 각 노드 안에서만 판단한다.

[loop 설정](../../loop/claude)이 **있어도 없어도** 동작한다. 함께 쓸 때는 서로의 파일을 덮어쓰지 않는다([공존](#loop-설정과의-공존) 참고).

## 구성

```
global/
  workflows/                 # ~/.claude/workflows/ — 저장된 그래프. /이름 으로 실행
    graph-build.js           #   요구사항 → 작업 DAG → 웨이브 병렬 구현 → 검증·수정 사이클 → 최종 게이트
    graph-review.js          #   범위 → 관점별 병렬 탐지 → 결함별 반증 (읽기 전용)
    graph-investigate.js     #   재현 → 관점별 가설 → 가설별 증거 → 판정 (읽기 전용)
  agents/                    # ~/.claude/agents/ — 노드
    graph-planner.md         #   작업 DAG 설계 (의존, 쓰기 범위, 인수 조건)
    graph-implementer.md     #   작업 하나 구현. 쓰기 범위 밖은 건드리지 않음
    graph-verifier.md        #   명령 실행과 코드로 판정. 소스는 고치지 않음
    graph-reviewer.md        #   작성자와 독립된 리뷰 (읽기 전용)
    graph-analyst.md         #   사실 수집·판정 (읽기 전용)
  skills/graph-design/       # ~/.claude/skills/ — 새 그래프를 설계·작성·검사하는 절차
  rules/graph-engineering.md # ~/.claude/rules/ — 언제 그래프를 쓰는지 (매 세션 로드, 5줄)
  graph/                     # ~/.claude/graph/ — 이 설정 전용 디렉터리
    bin/graph-check          #   그래프를 토큰 없이 검사·시뮬레이션 (~/.local/bin 에도 설치)
    hooks/node-guard.sh      #   구현 노드가 실행되는 동안만: 커밋·stash·reset·마이그레이션 적용 차단
    hooks/graph-context.sh   #   SessionStart: 끝나지 않은 그래프 실행을 컨텍스트에 알림
    templates/graph.template.js
  settings.graph.json        # settings.json 에 병합할 훅 조각 (SessionStart 하나)
install.sh                   # 추가만 하는 설치 / --check / --uninstall
tests/run.sh                 # 임시 디렉터리에서 그래프·훅·설치 시나리오 검사
```

## 설치

```bash
./install.sh
```

- 필요 도구: `jq`(훅, settings 병합), `node`(`graph-check`만. 그래프 실행에는 필요 없다).
- Workflow 기능이 켜진 Claude Code가 필요하다. Pro 플랜은 `/config`에서 켠다.
- 설치하는 경로는 전부 이름이 `graph`로 시작한다. 그렇지 않은 경로에는 쓰지 않는다. `CLAUDE.md`는 만들지도 고치지도 않는다.
- `settings.json`은 교체하지 않는다. `SessionStart`에 훅 하나를 추가하고, 바뀔 때만 `settings.json.bak.graph.<시각>`으로 백업한다. 넣고 뺄 때는 `settings.graph.json`에 적힌 명령과 글자까지 같은 훅만 자기 것으로 본다. 병합을 원하지 않으면 `--no-settings`.
- 같은 이름의 파일이 이미 있고 이 스크립트가 만든 것이 아니면 `*.bak.<시각>`으로 보존한다.
- 심볼릭 링크로 설치한다. Windows Git Bash처럼 링크가 복사본으로 만들어지는 환경에서는 저장소를 고친 뒤 `./install.sh`를 다시 실행한다.

```bash
./install.sh --check       # 빠지거나 오래된 항목 점검
./install.sh --uninstall   # 이 스크립트가 설치한 것만 제거 (프로젝트의 실행 기록은 남김)
```

## loop 설정과의 공존

loop 설정의 `install.sh`는 `CLAUDE.md`, `settings.json`, `hooks/`, `loop/`를 통째로 자기 것으로 교체한다. 이 설정은 그 경로들을 쓰지 않도록 만들었다.

| 경로 | loop | graph | 충돌 |
|---|---|---|---|
| `CLAUDE.md` | 교체 | 사용 안 함 (`rules/graph-engineering.md`로 대신) | 없음 |
| `hooks/`, `loop/` | 디렉터리째 링크 | 사용 안 함 (`graph/`에 둠) | 없음 |
| `agents/`, `skills/`, `rules/` | 파일별 링크 | `graph-*` 이름만 추가 | 없음 |
| `workflows/` | 사용 안 함 | `graph-*.js` 추가 | 없음 |
| `settings.json` | 교체 | 훅 하나를 병합 | 아래 참고 |
| `~/.local/bin` | `claude-loop` | `graph-check` | 없음 |

`settings.json`만 순서에 따라 손이 간다.

- **loop 다음에 graph**: graph가 loop의 권한·훅을 그대로 두고 훅 하나를 더한다. 단, `settings.json`이 loop 저장소를 가리키는 심볼릭 링크면 남의 저장소 파일을 고치게 되므로 병합을 건너뛰고 알려 준다. 그 파일에 넣으려면 `./install.sh --merge-linked-settings`. 훅이 없어도 그래프는 동작하고, 끝나지 않은 실행을 세션 시작 때 알려 주는 기능만 빠진다.
- **graph 다음에 loop**: loop가 `settings.json`을 교체하므로 graph 훅이 빠진다. 나머지 graph 파일은 그대로다. `./install.sh --check`가 알려 주고, `./install.sh`를 다시 실행하면 복구된다.

함께 쓸 때 얻는 것:

- loop의 `guard-bash.sh`, `format.sh`는 그래프 노드의 도구 호출에도 적용된다.
- 역할이 나뉜다. **루프**는 긴 계획을 반복마다 새 세션으로 하나씩 처리하고(`claude-loop`), **그래프**는 한 세션 안에서 여러 노드를 병렬로 돌린다. 루프의 한 반복 안에서 그래프를 쓸 수는 있지만 headless(`claude -p`)에서는 승인 창이 뜨지 않으므로 `permissions.allow`에 `Workflow(graph-build)` 같은 규칙이 필요하다.

loop 없이 쓸 때: 위험 명령 가드와 종료 전 검증 훅이 없다. 그래프 안에서는 `node-guard.sh`와 검증 노드가 그 역할을 하지만, 그래프 밖의 일반 세션에는 적용되지 않는다.

## 사용

그래프는 사용자가 요청할 때만 실행된다. 에이전트를 여러 개 띄우므로 한두 파일짜리 작업에는 쓰지 않는다.

### /graph-build — 작업 DAG 병렬 구현

```
/graph-build 주문 목록 API를 커서 페이징으로 바꾸고 웹 목록 화면에 무한 스크롤 적용
```

```
계획 ──▶ [계획 검증: 고유 ID · 의존 존재 · 비순환] ──▶ 웨이브 1 ──▶ 웨이브 2 ──▶ … ──▶ 최종 게이트
                                                        │
                                  구현 ∥ 구현 ∥ 구현 ──▶ 검증 ──(실패)──▶ 수정 ──▶ 재검증 (최대 2회)
```

- **웨이브**: 선행 작업이 모두 통과했고 쓰기 범위(`files`)가 서로 겹치지 않는 작업만 함께 실행한다. 범위를 밝히지 않은 작업은 혼자 실행한다.
- **검증은 웨이브가 끝난 뒤에** 한다. 다른 노드가 파일을 고치는 중에 타입 체크를 돌리면 엉뚱하게 실패하기 때문이다.
- 선행 작업이 실패하거나 막히면 그 뒤 작업은 실행하지 않고 `skipped`로 보고한다.
- **최종 게이트**: 전체 검증과 독립 리뷰를 병렬로 돌리고, 검증 실패나 심각도 높음 결함이 있으면 고친 뒤 다시 판정한다(최대 2회).
- 노드는 커밋하지 않는다. 결과를 확인한 뒤 사람이 커밋한다.

| args | 기본값 | 설명 |
|---|---|---|
| `request` | — | 요구사항 (문자열만 넘겨도 된다) |
| `planOnly` | `false` | 계획만 세우고 멈춘다. 확인 후 `plan`에 넣어 다시 실행 |
| `plan` | — | 확정된 계획 객체. 계획 노드를 건너뛴다 |
| `resume` + `outDir` | — | 중단된 실행을 `plan.json`·`progress.md`에서 이어간다 |
| `maxTasks` / `maxParallel` / `maxFixRounds` | 12 / 4 / 2 | 작업 수, 웨이브 폭, 수정 사이클 상한 |
| `review` | `true` | 최종 게이트의 독립 리뷰 |
| `model`, `models` | 세션 모델 | 전체 또는 노드별 모델 (`{planner, implementer, verifier, reviewer}`) |

최악의 경우 에이전트 수는 대략 `1 + 작업 수 × (1 + maxFixRounds) + 웨이브 수 × (1 + maxFixRounds) + 3 × (1 + maxFixRounds)`다.

### /graph-review — 관점별 탐지와 반증

```
/graph-review                      # 미커밋 변경 + 기본 브랜치 대비 변경
/graph-review feature/orders-paging
```

정확성·보안·데이터·테스트 관점의 리뷰어가 서로의 결과를 모른 채 결함을 찾고, 중복을 합친 뒤 결함마다 다른 노드가 반증을 시도한다. 반증되지 않은 것만 `confirmed`로 돌아온다. 검증자가 판정을 내지 못한 결함은 반증된 것으로 치지 않고 `unverified`로 따로 돌아오며 상태는 `PARTIAL`이 된다. `votes`(기본 1, 최대 9)를 3으로 올리면 결함당 세 명이 판정해 과반으로 정한다. 파일을 고치지 않는다.

### /graph-investigate — 원인 진단

```
/graph-investigate OrderServiceTest.createsOrder 가 CI에서만 간헐적으로 실패한다
```

증상을 재현하고, 최근 변경·코드 경로·데이터와 상태·환경 관점에서 독립적으로 가설을 세운 뒤, 가설을 세운 노드와 다른 노드가 증거로 확인하거나 기각한다. 확인된 가설이 없으면 추측을 원인으로 내지 않고 `UNDETERMINED`로 보고한다. 파일을 고치지 않는다. 수정은 진단을 본 뒤 직접 하거나 `/graph-build`에 넘긴다.

### 새 그래프 만들기

```
/graph-design 릴리스 노트 생성: 머지된 PR을 모아 영역별로 요약하고 사실 확인 후 합치기
```

`graph-design` 스킬이 노드·엣지·게이트·정지 조건을 먼저 그리게 하고, 템플릿에서 시작해 `graph-check`로 검사한 뒤 `.claude/workflows/`(프로젝트) 또는 `~/.claude/workflows/`(전역)에 저장한다. 직접 만든 그래프 이름에는 `graph-` 접두사를 쓰지 않는다(이 설정이 관리하는 이름이다).

## graph-check

그래프를 실제로 돌리면 에이전트 수십 개만큼 토큰이 든다. 분기와 사이클은 그 전에 스텁으로 확인한다.

```bash
graph-check my-graph.js                                  # meta 리터럴, 문법, 금지 API, phase 일치
graph-check my-graph.js --sim --args '{"target":"src"}'  # 노드를 스키마 기반 스텁으로 바꿔 끝까지 실행
graph-check my-graph.js --sim --fixture fixture.mjs      # 노드별 응답을 지정
```

픽스처는 `export default (prompt, opts, n) => 값`이다. `opts.label`로 노드를 구분해 실패·빈 결과를 돌려주면 실패 경로에서 사이클이 상한에서 멈추는지, 0건일 때 뒤 단계를 건너뛰는지, 최대 동시 실행 수가 예상과 맞는지를 볼 수 있다. 예시는 `tests/fixtures/`에 있다. 한계: 중첩 `workflow()`, 동시 실행 상한, 토큰 예산은 흉내 내지 않는다.

Windows Git Bash는 슬래시로 시작하는 인자를 Windows 경로로 바꾼다. `--args '/api 느림'`처럼 쓰지 말고 `--args '{"request":"/api 느림"}'`처럼 JSON으로 넘긴다.

## 실행 기록

`/graph-build`는 프로젝트의 `.claude/graph/runs/<요구사항에서 만든 이름>/`에 `plan.json`(계획 노드)과 `progress.md`(검증 노드의 판정)를 남긴다. Workflow의 재개는 같은 세션 안에서만 되므로, 세션이 바뀐 뒤에는 이 파일이 기억이다. `graph-context.sh`가 끝나지 않은 실행을 세션 시작 때 알려 준다. 저장소에 넣지 않으려면 `.gitignore`에 `.claude/graph/runs/`를 추가한다.

## 설계 원칙

- **흐름은 코드로, 판단은 노드로.** 무엇을 병렬로 돌리고 언제 멈출지는 스크립트가 정한다. "다음에 누구에게 넘길지"를 모델에게 묻지 않는다.
- **엣지에는 계약이 있다.** 다음 노드나 분기 조건이 쓰는 값은 스키마로 받는다. 스키마가 잡지 못하는 그래프 속성(순환, 없는 의존)은 코드로 검증한다.
- **만든 노드가 판정하지 않는다.** 구현과 검증, 탐지와 반증, 가설과 증거를 다른 노드가 맡는다. 판정 노드에는 작성자의 설명을 넘기지 않는다.
- **쓰기는 범위로 격리한다.** 병렬 구현은 쓰기 범위가 겹치지 않을 때만 한다. 구현 노드는 작업 트리 전체를 건드리는 명령을 쓸 수 없다.
- **모든 사이클에 상한이 있다.** 수정 횟수, 작업 수, 병렬 폭, 검증할 결함 수. 상한 때문에 버린 것은 반환값에 남긴다.
- **실패도 결과다.** 막힌 작업과 그 때문에 건너뛴 작업을 그대로 보고한다. 일부가 실패해도 독립인 가지는 끝까지 간다.
- **되돌리기 어려운 일은 그래프 밖에서.** 커밋, push, 마이그레이션 적용, 배포는 노드가 하지 않는다.
- **아무것도 덮어쓰지 않는다.** 설치는 자기 이름의 파일만 추가하고, 공유 파일은 병합하며, 제거하면 원래대로 돌아간다.

## 검사

```bash
tests/run.sh
```

실제 `~/.claude`를 건드리지 않고 임시 디렉터리에서 그래프 정적 검사·시뮬레이션, 훅 판정, 설치 시나리오(단독, 기존 설정 보존, loop → graph, graph → loop, 제거)를 확인한다. loop 저장소가 `../../loop/claude`에 없으면 공존 시나리오는 건너뛴다(`LOOP_REPO`로 위치 지정).
