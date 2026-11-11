#!/usr/bin/env bash
# SessionStart: 프로젝트에 끝나지 않은 그래프 실행이 있으면 컨텍스트에 알린다.
# Workflow 의 재개는 같은 세션 안에서만 되므로, 세션이 바뀌거나 컨텍스트가 압축된 뒤에는
# 파일(plan.json, progress.md)이 유일한 기억이다. 해당 실행이 없으면 아무것도 출력하지 않는다.
command -v jq >/dev/null 2>&1 || exit 0

input="$(cat)"
cwd="$(jq -r '.cwd // empty' <<<"$input" 2>/dev/null)"
[ -n "$cwd" ] || cwd="$PWD"
root="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || echo "$cwd")"
runs="$root/.claude/graph/runs"
[ -d "$runs" ] || exit 0

ctx=""
n=0
# 최근에 바뀐 실행부터 본다.
while IFS= read -r plan; do
  [ -f "$plan" ] || continue
  dir="$(dirname "$plan")"
  total="$(jq -r '.tasks | length' "$plan" 2>/dev/null)" || continue
  case "$total" in '' | *[!0-9]*) continue ;; esac
  # 같은 작업이 재시도로 여러 번 기록될 수 있으므로 작업별 마지막 판정만 센다.
  pass=0
  if [ -f "$dir/progress.md" ]; then
    pass="$(awk '$1 == "-" && ($2 == "PASS" || $2 == "FAIL") { last[$3] = $2 } END { c = 0; for (k in last) if (last[k] == "PASS") c++; print c }' "$dir/progress.md")"
  fi
  [ "$pass" -lt "$total" ] || continue
  ctx+="- ${dir#"$root"/}: 통과 $pass / 전체 $total — $(jq -r '.summary // "" | .[0:80]' "$plan" 2>/dev/null)"$'\n'
  n=$((n + 1))
  [ "$n" -ge 5 ] && break
done < <(ls -t "$runs"/*/plan.json 2>/dev/null)

[ -n "$ctx" ] || exit 0
ctx="## 끝나지 않은 그래프 실행 (SessionStart 훅)"$'\n'"$ctx"'이어가려면 /graph-build 에 {resume: true, outDir: "<경로>"} 를 넘긴다. 사용자가 요청할 때만 실행한다.'
jq -n --arg c "$ctx" '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $c}}'
