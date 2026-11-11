#!/usr/bin/env bash
# 그래프 엔지니어링 설정의 자체 검사. 실제 ~/.claude 는 건드리지 않고 임시 디렉터리에서만 실행한다.
#
#   tests/run.sh            전체
#   LOOP_REPO=<경로>        loop 설정 저장소 위치 (기본: ../../loop/claude). 없으면 공존 시나리오를 건너뛴다.
set -uo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loop_repo="${LOOP_REPO:-$repo/../../loop/claude}"
check="$repo/global/graph/bin/graph-check"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

pass=0 fail=0
ok() { pass=$((pass + 1)); echo "  ✔ $1"; }
no() { fail=$((fail + 1)); echo "  ✖ $1"; }
t() { # t <설명> <명령...> — 명령이 성공하면 통과
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then ok "$name"; else no "$name"; fi
}
eq() { # eq <설명> <기대> <실제>
  if [ "$2" = "$3" ]; then ok "$1"; else no "$1 (기대: $2, 실제: $3)"; fi
}

# 임시 설정 디렉터리에 설치 스크립트를 실행한다.
graph_install() { CLAUDE_CONFIG_DIR="$1" CLAUDE_GRAPH_BIN_DIR="$1/bin" bash "$repo/install.sh" "${@:2}"; }
# loop 는 복사본에서 설치한다. 심볼릭 링크가 되는 환경에서 settings.json 병합이 실제 loop 저장소에 쓰이지 않게 한다.
loop_install() { CLAUDE_CONFIG_DIR="$1" CLAUDE_LOOP_BIN_DIR="$1/bin" bash "$work/loop-src/install.sh"; }
# loop 가 설치한 것의 지문: settings.json 을 뺀 모든 파일의 내용 해시
loop_fingerprint() { (cd "$1" && find -L CLAUDE.md hooks loop agents/reviewer.md rules skills -type f ! -path 'skills/graph-*' ! -name 'graph-*' -exec sha1sum {} + 2>/dev/null | sort -k2); }
graph_hooks() { jq '[.hooks // {} | .[]? | .[]? | .hooks[]? | select((.command // "") | contains("/graph/hooks/"))] | length' "$1/settings.json"; }
without_graph() { jq -S 'if .hooks then .hooks |= with_entries(.value |= (map(.hooks |= map(select((.command // "") | contains("/graph/hooks/") | not))) | map(select(.hooks | length > 0)))) | .hooks |= with_entries(select(.value | length > 0)) else . end | if .hooks == {} then del(.hooks) else . end' "$1"; }

echo "── 그래프 정적 검사와 시뮬레이션"
for w in "$repo"/global/workflows/*.js "$repo"/global/graph/templates/*.js; do
  t "정적 검사: $(basename "$w")" node "$check" "$w"
done
t "잘못된 스크립트는 거부" bash -c "! node '$check' '$repo/tests/fixtures/bad-graph.js'"

sim="$(node "$check" "$repo/global/workflows/graph-build.js" --sim --quiet --fixture "$repo/tests/fixtures/build-dag.mjs" --args '"목록 페이징"' 2>"$work/trace")"
eq "build: 실패·건너뜀이 있으면 INCOMPLETE" INCOMPLETE "$(jq -r .status <<<"$sim")"
eq "build: 작업별 최종 상태" "pass pass pass pass pass blocked skipped" "$(jq -r '[.tasks[].state] | join(" ")' <<<"$sim")"
eq "build: 게이트는 수정 뒤 통과, high 결함 없음" "true 0" "$(jq -r '"\(.gate.pass) \([.findings[] | select(.severity == "high")] | length)"' <<<"$sim")"
trace="$(node "$check" "$repo/global/workflows/graph-build.js" --sim --fixture "$repo/tests/fixtures/build-dag.mjs" --args '"x"' 2>&1 >/dev/null)"
eq "build: 쓰기 범위가 겹치는 T2·T5 는 다른 웨이브" 0 "$(grep -c '웨이브.*T2.*T5\|웨이브.*T5.*T2' <<<"$trace")"
eq "build: T3 수정 사이클 1회" 1 "$(grep -c 'fix:T3' <<<"$trace")"
eq "build: 순환 의존은 실행 전에 거부" PLAN_INVALID "$(node "$check" "$repo/global/workflows/graph-build.js" --sim --quiet --args '{"plan":{"summary":"","blocked":"","verifyCommand":"","tasks":[{"id":"A","title":"","detail":"","deps":["B"],"files":["a"],"acceptance":[],"verify":""},{"id":"B","title":"","detail":"","deps":["A"],"files":["b"],"acceptance":[],"verify":""}]}}' 2>/dev/null | jq -r .status)"
eq "build: 검증이 계속 실패하면 상한에서 멈춤" "fail 3" "$(node "$check" "$repo/global/workflows/graph-build.js" --sim --fixture "$repo/tests/fixtures/build-always-fail.mjs" --args '"x"' 2>"$work/t2" | jq -r '.tasks[0].state') $(grep -c 'verify:w1' "$work/t2")"
B="$repo/global/workflows/graph-build.js"
t "build: maxParallel 이 음수여도 끝난다" timeout 20 node "$check" "$B" --sim --quiet --fixture "$repo/tests/fixtures/build-dag.mjs" --args '{"request":"x","maxParallel":-1}'
eq "build: maxFixRounds 가 숫자가 아니면 기본 상한" "fail 3" "$(timeout 20 node "$check" "$B" --sim --fixture "$repo/tests/fixtures/build-always-fail.mjs" --args '{"request":"x","maxFixRounds":"many"}' 2>"$work/t3" | jq -r '.tasks[0].state') $(grep -c 'verify:w1' "$work/t3")"
eq "build: 형태가 틀린 plan 은 예외가 아니라 PLAN_INVALID" "PLAN_INVALID PLAN_INVALID" "$(node "$check" "$B" --sim --quiet --args '{"plan":{}}' 2>/dev/null | jq -r .status) $(node "$check" "$B" --sim --quiet --args '{"plan":{"tasks":[{"id":"A"}]}}' 2>/dev/null | jq -r .status)"
rs="$(node "$check" "$B" --sim --fixture "$repo/tests/fixtures/build-resume-done.mjs" --args '{"resume":true,"outDir":"x"}' 2>"$work/t4")"
eq "build: resume 에서 전부 done 이어도 최종 게이트를 실행" "INCOMPLETE 1" "$(jq -r .status <<<"$rs") $(grep -c 'gate:verify ' "$work/t4")"
eq "build: 구현 노드가 null 이어도 blocked 로 보고" "INCOMPLETE blocked" "$(node "$check" "$B" --sim --quiet --fixture "$repo/tests/fixtures/build-null.mjs" --args '"x"' 2>/dev/null | jq -r '"\(.status) \(.tasks[0].state)"')"
eq "build: 요구사항 없이는 에이전트를 띄우지 않음" NO_REQUEST "$(node "$check" "$repo/global/workflows/graph-build.js" --sim --quiet 2>/dev/null | jq -r .status)"
eq "review: 변경이 없으면 조기 종료" NOTHING_TO_REVIEW "$(node "$check" "$repo/global/workflows/graph-review.js" --sim --quiet 2>/dev/null | jq -r .status)"
rv="$(node "$check" "$repo/global/workflows/graph-review.js" --sim --quiet --fixture "$repo/tests/fixtures/review.mjs" --args '{"votes":3}' 2>/dev/null)"
eq "review: 중복 제거 후 과반 반증된 결함은 탈락" "1 1" "$(jq -r '"\(.confirmed | length) \(.refuted | length)"' <<<"$rv")"
eq "review: 검증자가 판정하지 못한 결함은 unverified" "PARTIAL 2 0" "$(node "$check" "$repo/global/workflows/graph-review.js" --sim --quiet --fixture "$repo/tests/fixtures/review-null.mjs" 2>/dev/null | jq -r '"\(.status) \(.unverified | length) \(.refuted | length)"')"
eq "review: dimensions 를 문자열로 줘도 동작" NOTHING_TO_REVIEW "$(node "$check" "$repo/global/workflows/graph-review.js" --sim --quiet --args '{"dimensions":"security"}' 2>/dev/null | jq -r .status)"
node "$check" "$B" --simulate >/dev/null 2>&1
eq "graph-check: 모르는 옵션은 사용법 오류(2)" 2 "$?"
eq "investigate: 가설이 없으면 조기 종료" NO_HYPOTHESIS "$(node "$check" "$repo/global/workflows/graph-investigate.js" --sim --quiet --args '"x"' 2>/dev/null | jq -r .status)"
eq "investigate: 확인된 가설로 진단" DIAGNOSED "$(node "$check" "$repo/global/workflows/graph-investigate.js" --sim --quiet --fixture "$repo/tests/fixtures/investigate.mjs" --args '"x"' 2>/dev/null | jq -r .status)"

echo "── 훅"
guard() { jq -n --arg c "$1" '{tool_input: {command: $c}}' | bash "$repo/global/graph/hooks/node-guard.sh" | jq -r '.hookSpecificOutput.permissionDecision // "allow"' 2>/dev/null || echo allow; }
for c in 'git commit -m x' 'cd api && git stash' 'git -C . reset --hard' 'git checkout -- src/a.ts' './gradlew flywayMigrate' \
  'GIT_PAGER=cat git commit -m x' 'if true; then git reset --hard; fi' 'bash -c "git stash"' 'sudo git clean -fd' 'git commit;echo' 'git pull --rebase' \
  'mvn flyway:migrate' 'alembic -c alembic.ini upgrade head' './gradlew :api:flywayMigrate' 'python manage.py migrate'; do
  eq "node-guard 차단: $c" deny "$(guard "$c")"
done
for c in 'git status --short' 'git diff HEAD' 'git log --oneline -5' 'npm test' 'git grep -n reset src' './gradlew -Pflyway.url=x clean test' 'git add -N src/a.ts'; do
  eq "node-guard 허용: $c" "" "$(guard "$c" | grep -v allow)"
done
proj="$work/proj"
mkdir -p "$proj/.claude/graph/runs/a" "$proj/.claude/graph/runs/b"
echo '{"summary":"진행 중","tasks":[{"id":"T1"},{"id":"T2"}]}' >"$proj/.claude/graph/runs/a/plan.json"
printf -- '- FAIL T1 x — 이유\n- PASS T1 x\n' >"$proj/.claude/graph/runs/a/progress.md"
echo '{"summary":"끝남","tasks":[{"id":"T1"}]}' >"$proj/.claude/graph/runs/b/plan.json"
printf -- '- PASS T1 x\n' >"$proj/.claude/graph/runs/b/progress.md"
ctx="$(jq -n --arg d "$proj" '{cwd: $d}' | bash "$repo/global/graph/hooks/graph-context.sh" | jq -r '.hookSpecificOutput.additionalContext')"
t "graph-context: 끝나지 않은 실행만 알림" bash -c "grep -q 'runs/a: 통과 1 / 전체 2' <<<'$ctx' && ! grep -q 'runs/b' <<<'$ctx'"
eq "graph-context: 실행 기록이 없으면 출력 없음" "" "$(jq -n --arg d "$work" '{cwd: $d}' | bash "$repo/global/graph/hooks/graph-context.sh")"

echo "── 설치: 단독"
d="$work/solo"
mkdir -p "$d"
t "빈 디렉터리에 설치" graph_install "$d"
t "설치 직후 --check 통과" graph_install "$d" --check
eq "SessionStart 훅 1개" 1 "$(graph_hooks "$d")"
t "CLAUDE.md 를 만들지 않음" bash -c "[ ! -e '$d/CLAUDE.md' ] && [ ! -e '$d/hooks' ]"
before="$(jq -S . "$d/settings.json")"
t "다시 설치(멱등)" graph_install "$d"
eq "다시 설치해도 settings.json 동일" "$before" "$(jq -S . "$d/settings.json")"
eq "다시 설치해도 훅 1개" 1 "$(graph_hooks "$d")"
eq "자기 파일을 백업으로 남기지 않음" 0 "$(find "$d" -name '*.bak.2*' ! -name 'settings.json.bak.graph.*' | wc -l | tr -d ' ')"
t "설치된 graph-check 실행" node "$d/bin/graph-check" "$d/workflows/graph-build.js"
t "제거" graph_install "$d" --uninstall
eq "제거 후 graph 파일 없음" 0 "$(find "$d" -name 'graph*' ! -name '*.bak.*' | wc -l | tr -d ' ')"
eq "제거 후 settings.json 에 훅 없음" "{}" "$(jq -c . "$d/settings.json")"

echo "── 설치: 기존 설정 보존"
d="$work/existing"
mkdir -p "$d/agents"
cat >"$d/settings.json" <<'JSON'
{"model":"opus","permissions":{"deny":["Read(**/.env)"]},"hooks":{"SessionStart":[{"matcher":"startup","hooks":[{"type":"command","command":"other-hook.exe"}]}],"Stop":[{"hooks":[{"type":"command","command":"stop.sh"}]}]}}
JSON
orig="$(jq -S . "$d/settings.json")"
echo "내가 만든 에이전트" >"$d/agents/graph-planner.md"
echo "남의 에이전트" >"$d/agents/reviewer.md"
t "설치" graph_install "$d"
eq "기존 settings 항목이 그대로" "$orig" "$(without_graph "$d/settings.json")"
eq "같은 이벤트에 훅이 추가됨" 2 "$(jq '.hooks.SessionStart | length' "$d/settings.json")"
t "이름이 겹친 사용자 파일은 백업" bash -c "grep -q '내가 만든' '$d'/agents/graph-planner.md.bak.*"
eq "graph 가 아닌 파일은 그대로" "남의 에이전트" "$(cat "$d/agents/reviewer.md")"
t "제거" graph_install "$d" --uninstall
eq "제거 후 settings.json 원상 복구" "$orig" "$(jq -S . "$d/settings.json")"
d="$work/foreign"
mkdir -p "$d"
echo '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"/home/me/work/graph/hooks/my-own.sh"}]}],"Stop":[],"PostToolUse":[{"matcher":"Edit","hooks":[]}]}}' >"$d/settings.json"
orig="$(jq -S . "$d/settings.json")"
t "경로에 /graph/hooks/ 가 든 남의 훅이 있어도 설치" graph_install "$d"
eq "남의 훅과 빈 항목을 지우지 않음" "$orig" "$(jq -S 'del(.hooks.SessionStart)' "$d/settings.json")"
t "제거" graph_install "$d" --uninstall
eq "제거 후에도 그대로" "$orig" "$(jq -S . "$d/settings.json")"
d="$work/empty"
mkdir -p "$d"
: >"$d/settings.json"
t "0바이트 settings.json 에 설치" graph_install "$d"
eq "0바이트였어도 훅이 들어감" 1 "$(graph_hooks "$d")"
d="$work/bins"
mkdir -p "$d"
t "bin 디렉터리 A 로 설치" env CLAUDE_CONFIG_DIR="$d" CLAUDE_GRAPH_BIN_DIR="$d/binA" bash "$repo/install.sh"
t "bin 디렉터리를 B 로 바꿔 다시 설치" env CLAUDE_CONFIG_DIR="$d/" CLAUDE_GRAPH_BIN_DIR="$d/binB" bash "$repo/install.sh"
t "이전 bin 의 graph-check 는 치워짐" bash -c "[ ! -e '$d/binA/graph-check' ] && [ -e '$d/binB/graph-check' ]"
eq "경로 끝 슬래시가 달라도 자기 파일을 백업하지 않음" 0 "$(find "$d" -name '*.bak.2*' ! -name 'settings.json.bak.graph.*' | wc -l | tr -d ' ')"
rm -f "$d/.graph-engineering.manifest"
t "매니페스트를 잃고 다시 설치" env CLAUDE_CONFIG_DIR="$d" CLAUDE_GRAPH_BIN_DIR="$d/binB" bash "$repo/install.sh"
eq "매니페스트를 잃어도 자기 복사본을 백업하지 않음" 0 "$(find "$d" -name '*.bak.2*' ! -name 'settings.json.bak.graph.*' | wc -l | tr -d ' ')"
t "bin 디렉터리가 달라도 제거가 끝까지 감" env CLAUDE_CONFIG_DIR="$d" CLAUDE_GRAPH_BIN_DIR="$d/binC" bash "$repo/install.sh" --uninstall
eq "제거 후 훅도 빠짐" 0 "$(graph_hooks "$d")"
d="$work/existing"
echo '{ 깨진 json' >"$d/settings.json"
t "깨진 settings.json 은 병합을 거부" bash -c "! CLAUDE_CONFIG_DIR='$d' CLAUDE_GRAPH_BIN_DIR='$d/bin' bash '$repo/install.sh'"
eq "깨진 settings.json 을 덮어쓰지 않음" '{ 깨진 json' "$(cat "$d/settings.json")"

if [ -f "$loop_repo/install.sh" ]; then
  loop_head="$(git -C "$loop_repo" status --porcelain 2>/dev/null)"
  mkdir -p "$work/loop-src"
  cp -R "$loop_repo/global" "$loop_repo/install.sh" "$work/loop-src/"

  echo "── 공존: loop 설치 후 graph 설치"
  d="$work/loop-first"
  mkdir -p "$d"
  t "loop 설치" loop_install "$d"
  fp="$(loop_fingerprint "$d")"
  loop_settings="$(jq -S . "$d/settings.json")"
  t "graph 설치" graph_install "$d" --merge-linked-settings
  eq "loop 파일이 하나도 바뀌지 않음" "$fp" "$(loop_fingerprint "$d")"
  eq "loop 의 settings 항목(권한·훅)이 그대로" "$loop_settings" "$(without_graph "$d/settings.json")"
  eq "loop 의 SessionStart 훅 + graph 훅" 2 "$(jq '.hooks.SessionStart | length' "$d/settings.json")"
  t "graph --check 통과" graph_install "$d" --check --merge-linked-settings
  t "loop 훅 스크립트가 여전히 실행됨" bash -c "echo '{\"tool_input\":{\"command\":\"ls\"}}' | bash '$d/hooks/guard-bash.sh'"
  t "graph 제거" graph_install "$d" --uninstall --merge-linked-settings
  eq "제거 후 loop 파일 그대로" "$fp" "$(loop_fingerprint "$d")"
  eq "제거 후 settings.json 이 loop 원본과 동일" "$loop_settings" "$(jq -S . "$d/settings.json")"

  echo "── 공존: graph 설치 후 loop 설치"
  d="$work/graph-first"
  mkdir -p "$d"
  t "graph 설치" graph_install "$d"
  t "loop 설치 (settings.json 을 교체함)" loop_install "$d"
  loop_settings="$(jq -S . "$d/settings.json")"
  t "graph 의 에이전트·워크플로·규칙·스킬은 남아 있음" bash -c "[ -e '$d/agents/graph-planner.md' ] && [ -e '$d/workflows/graph-build.js' ] && [ -e '$d/rules/graph-engineering.md' ] && [ -e '$d/skills/graph-design/SKILL.md' ] && [ -e '$d/graph/hooks/node-guard.sh' ]"
  t "--check 가 빠진 훅을 알려 줌" bash -c "! CLAUDE_CONFIG_DIR='$d' CLAUDE_GRAPH_BIN_DIR='$d/bin' bash '$repo/install.sh' --check --merge-linked-settings"
  fp="$(loop_fingerprint "$d")"
  t "graph 재설치로 복구" graph_install "$d" --merge-linked-settings
  eq "복구 후 loop 파일 그대로" "$fp" "$(loop_fingerprint "$d")"
  eq "복구 후 loop 의 settings 항목 그대로" "$loop_settings" "$(without_graph "$d/settings.json")"
  eq "복구 후 graph 훅 1개" 1 "$(graph_hooks "$d")"

  if [ -L "$d/settings.json" ]; then
    echo "── 공존: settings.json 이 링크일 때 기본 동작"
    graph_install "$d" --uninstall --merge-linked-settings >/dev/null 2>&1
    linked="$(cat "$d/settings.json")"
    t "graph 설치 (옵션 없음)" graph_install "$d"
    eq "링크된 settings.json 은 건드리지 않음" "$linked" "$(cat "$d/settings.json")"
    t "--check 는 훅 생략을 정상으로 봄" graph_install "$d" --check
  fi
  eq "loop 저장소의 작업 트리가 테스트 전과 같음" "$loop_head" "$(git -C "$loop_repo" status --porcelain 2>/dev/null)"
else
  echo "── 공존 시나리오 건너뜀: $loop_repo/install.sh 없음"
fi

echo
echo "통과 $pass · 실패 $fail"
[ "$fail" -eq 0 ]
