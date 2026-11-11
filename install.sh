#!/usr/bin/env bash
# 그래프 엔지니어링 설정을 ~/.claude 에 "추가만" 한다.
#
# - 설치하는 것은 전부 이름이 graph 로 시작한다. 그렇지 않은 경로에는 쓰지 않는다.
# - CLAUDE.md, hooks/, loop/, 다른 스킬·에이전트·규칙은 읽지도 쓰지도 않는다.
# - settings.json 은 교체하지 않고 graph 훅 항목만 jq 로 넣고 뺀다(멱등).
# - 설치한 경로를 매니페스트에 기록해, 다시 설치하거나 제거할 때 자기 것만 건드린다.
set -euo pipefail

usage() {
  cat <<'EOF'
사용법: install.sh [옵션]

  (옵션 없음)               설치 또는 갱신
  --check                   설치 상태 점검만 한다. 빠지거나 오래된 항목이 있으면 종료 코드 1
  --uninstall               이 스크립트가 설치한 것만 제거한다
  --no-settings             settings.json 을 건드리지 않는다 (SessionStart 훅 없이 설치)
  --merge-linked-settings   settings.json 이 다른 저장소를 가리키는 심볼릭 링크여도 그 파일에 병합한다
  -h, --help

환경 변수: CLAUDE_CONFIG_DIR (기본 ~/.claude), CLAUDE_GRAPH_BIN_DIR (기본 ~/.local/bin)
EOF
}

mode=install with_settings=1 merge_linked=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) mode=check ;;
    --uninstall) mode=uninstall ;;
    --no-settings) with_settings=0 ;;
    --merge-linked-settings) merge_linked=1 ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 1 ;;
  esac
  shift
done

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
bin_dir="${CLAUDE_GRAPH_BIN_DIR:-$HOME/.local/bin}"
# 끝의 슬래시 유무로 같은 경로가 매니페스트에서 다른 문자열이 되지 않게 한다.
target_dir="${target_dir%/}"
bin_dir="${bin_dir%/}"
stamp="$(date +%Y%m%d%H%M%S)"
manifest="$target_dir/.graph-engineering.manifest"
settings="$target_dir/settings.json"
fragment="$repo_dir/global/settings.graph.json"

die() { echo "install.sh: $*" >&2; exit 1; }

# 설치 대상 목록: "<원본>\t<설치 위치>"
items() {
  local f
  printf '%s\t%s\n' "$repo_dir/global/graph" "$target_dir/graph"
  for f in "$repo_dir"/global/agents/*.md; do printf '%s\t%s\n' "$f" "$target_dir/agents/$(basename "$f")"; done
  for f in "$repo_dir"/global/rules/*.md; do printf '%s\t%s\n' "$f" "$target_dir/rules/$(basename "$f")"; done
  for f in "$repo_dir"/global/workflows/*.js; do printf '%s\t%s\n' "$f" "$target_dir/workflows/$(basename "$f")"; done
  for f in "$repo_dir"/global/skills/*/; do f="${f%/}"; printf '%s\t%s\n' "$f" "$target_dir/skills/$(basename "$f")"; done
  printf '%s\t%s\n' "$repo_dir/global/graph/bin/graph-check" "$bin_dir/graph-check"
}

# 이전 설치가 만든 경로인가: 매니페스트에 있거나, 이 저장소를 가리키는 링크이거나, 내용이 원본과 같다.
# 마지막 조건은 링크가 복사본이 되는 환경에서 매니페스트를 잃었을 때 자기 복사본을 남의 것으로 보지 않기 위해서다.
owned() { # owned <설치 위치> <원본>
  local dest="$1" src="$2"
  grep -qxF -- "$dest" "$manifest" 2>/dev/null && return 0
  [ -L "$dest" ] && case "$(readlink "$dest")" in "$repo_dir"/*) return 0 ;; esac
  diff -rq "$src" "$dest" >/dev/null 2>&1
}

# 지워도 되는 경로인가: 이름이 graph 로 시작한다. 매니페스트는 이 스크립트만 쓰지만, 손상됐을 때를 대비한 마지막 확인이다.
ours() { case "$(basename "$1")" in graph*) return 0 ;; esac; return 1; }

remove() { # remove <경로> <라벨> — 매니페스트에 적힌 경로를 지운다. 우리 것이 아니면 건너뛴다.
  local dest="$1"
  [ -e "$dest" ] || [ -L "$dest" ] || return 0
  if ours "$dest"; then
    rm -rf -- "$dest"
    echo "$2: $dest"
  else
    echo "건너뜀: $dest (graph 로 시작하지 않는 경로는 지우지 않습니다)" >&2
  fi
}

place() {
  local src="$1" dest="$2"
  ours "$dest" || die "graph 로 시작하지 않는 경로에는 설치하지 않습니다: $dest"
  case "$dest" in "$target_dir"/?* | "$bin_dir"/?*) ;; *) die "설치 디렉터리 밖의 경로입니다: $dest" ;; esac
  mkdir -p "$(dirname "$dest")"
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    if owned "$dest" "$src"; then
      rm -rf -- "$dest"
    else
      mv -- "$dest" "$dest.bak.$stamp"
      echo "백업: $dest -> $dest.bak.$stamp (이 스크립트가 만든 파일이 아니어서 보존)"
    fi
  fi
  # 심볼릭 링크를 만들 수 없는 환경(Windows Git Bash 기본값)에서는 ln -s 가 복사본을 만든다.
  ln -s "$src" "$dest"
  echo "설치: $dest"
}

# settings.json 에서 우리 훅 핸들러만 뺀다. "우리 것"은 조각 파일에 적힌 command 와 글자까지 같은 것이다.
# 그 때문에 비게 된 matcher 그룹·이벤트·hooks 만 정리하고, 원래 비어 있던 것은 그대로 둔다.
jq_defs='
  def ours: [$f[0].hooks[]?[]?.hooks[]?.command];
  def strip:
    ours as $cmds
    | if (.hooks | type) == "object" then
        (.hooks | length) as $events
        | .hooks |= with_entries(
            if (.value | type) == "array" then
              (.value | length) as $groups
              | .value |= map(
                  if (.hooks | type) == "array" then
                    (.hooks | length) as $handlers
                    | .hooks |= map(select((.command // "") as $c | ($cmds | index($c)) == null))
                    | if $handlers > 0 and (.hooks | length) == 0 then empty else . end
                  else . end)
              | if $groups > 0 and (.value | length) == 0 then empty else . end
            else . end)
        | if $events > 0 and (.hooks | length) == 0 then del(.hooks) else . end
      else . end;
'

# settings.json 을 jq 필터로 바꾼다. 내용이 달라질 때만 백업하고 쓴다.
update_settings() { # update_settings <jq 필터>
  local tmp
  jq -e 'type == "object"' "$settings" >/dev/null 2>&1 || die "$settings 이 JSON 객체가 아니어서 병합하지 않았습니다. 고친 뒤 다시 실행하세요."
  tmp="$(mktemp)"
  jq --slurpfile f "$fragment" "$jq_defs $1" "$settings" >"$tmp" || { rm -f "$tmp"; die "settings.json 병합에 실패했습니다. 파일은 바꾸지 않았습니다."; }
  if [ "$(jq -S . "$settings")" = "$(jq -S . "$tmp")" ]; then
    echo "settings.json: 변경 없음"
  else
    cp -p -- "$settings" "$settings.bak.graph.$stamp"
    # 리다이렉트로 써서 파일의 정체(심볼릭 링크, 권한)를 유지한다.
    cat "$tmp" >"$settings"
    echo "settings.json: 갱신 (백업 $settings.bak.graph.$stamp)"
  fi
  rm -f "$tmp"
}

# settings.json 이 다른 곳(예: loop 저장소)을 가리키는 링크면 남의 저장소 파일을 고치게 된다.
linked_elsewhere() { [ -L "$settings" ] && [ "$merge_linked" -eq 0 ]; }

settings_has_hook() {
  [ -f "$settings" ] && jq -e --slurpfile f "$fragment" "$jq_defs"' ours as $cmds | [.hooks // {} | .[]? | .[]? | .hooks[]? | .command // ""] | any(. as $c | $cmds | index($c) != null)' "$settings" >/dev/null 2>&1
}

case "$mode" in
  install)
    command -v jq >/dev/null 2>&1 || echo "경고: jq 가 없으면 graph 훅과 settings.json 병합이 동작하지 않습니다." >&2
    command -v node >/dev/null 2>&1 || echo "참고: node 가 없으면 graph-check(그래프 검사 도구)를 쓸 수 없습니다. 그래프 실행에는 영향이 없습니다." >&2

    new_manifest="$(mktemp)"
    while IFS=$'\t' read -r src dest; do
      place "$src" "$dest"
      echo "$dest" >>"$new_manifest"
    done < <(items)
    # 이전 설치에는 있었지만 지금은 없는 항목(이름이 바뀐 파일, 달라진 bin 디렉터리)을 치운다.
    if [ -f "$manifest" ]; then
      while IFS= read -r old; do
        [ -n "$old" ] || continue
        grep -qxF -- "$old" "$new_manifest" || remove "$old" "제거(더 이상 설치하지 않음)"
      done <"$manifest"
    fi
    mkdir -p "$target_dir"
    mv -- "$new_manifest" "$manifest"

    if [ "$with_settings" -eq 0 ]; then
      echo "settings.json: 건드리지 않음 (--no-settings)"
    elif ! command -v jq >/dev/null 2>&1; then
      echo "settings.json: jq 가 없어 병합하지 않았습니다." >&2
    elif linked_elsewhere; then
      echo "settings.json: $(readlink "$settings") 를 가리키는 링크라서 병합하지 않았습니다."
      echo "  그 파일에 직접 병합하려면 --merge-linked-settings 로 다시 실행하세요. 훅 없이도 그래프는 동작합니다."
    else
      # 없거나 0바이트면 빈 객체에서 시작한다.
      [ -s "$settings" ] || echo '{}' >"$settings"
      update_settings 'strip | reduce ($f[0].hooks | to_entries[]) as $e (.; .hooks[$e.key] = ((.hooks[$e.key] // []) + $e.value))'
    fi

    case ":$PATH:" in
      *":$bin_dir:"*) ;;
      *) echo "참고: $bin_dir 가 PATH 에 없습니다. graph-check 를 쓰려면 PATH 에 추가하세요." ;;
    esac
    echo "완료. Claude Code 를 다시 시작한 뒤 /graph-build, /graph-review, /graph-investigate 로 실행합니다."
    ;;

  uninstall)
    if [ -f "$manifest" ]; then
      while IFS= read -r dest; do
        [ -n "$dest" ] && remove "$dest" "제거"
      done <"$manifest"
      rm -f -- "$manifest"
    else
      echo "매니페스트($manifest)가 없습니다. 설치된 파일은 지우지 않고 settings.json 의 graph 훅만 확인합니다."
    fi
    if [ "$with_settings" -eq 1 ] && [ -s "$settings" ] && command -v jq >/dev/null 2>&1; then
      if linked_elsewhere; then
        if settings_has_hook; then echo "settings.json: 링크된 파일에 graph 훅이 남아 있습니다. --uninstall --merge-linked-settings 로 제거하세요."; fi
      else
        update_settings 'strip'
      fi
    fi
    echo "제거 완료. 프로젝트의 .claude/graph/runs/ 실행 기록은 남겨 두었습니다."
    ;;

  check)
    bad=0
    while IFS=$'\t' read -r src dest; do
      if [ ! -e "$dest" ]; then echo "없음    : $dest"; bad=1
      elif ! diff -rq "$src" "$dest" >/dev/null 2>&1; then echo "오래됨  : $dest"; bad=1
      else echo "정상    : $dest"; fi
    done < <(items)
    if [ "$with_settings" -eq 1 ]; then
      if settings_has_hook; then echo "정상    : settings.json 의 SessionStart 훅"
      elif linked_elsewhere; then echo "생략    : settings.json 이 링크라서 훅을 병합하지 않았습니다 (선택 사항)"
      else echo "없음    : settings.json 의 SessionStart 훅 (settings.json 이 교체됐다면 install.sh 를 다시 실행)"; bad=1; fi
    fi
    command -v jq >/dev/null 2>&1 || { echo "없음    : jq"; bad=1; }
    if [ "$bad" -eq 0 ]; then echo "모두 정상입니다."; else echo "install.sh 를 다시 실행하면 복구됩니다."; fi
    exit "$bad"
    ;;
esac
