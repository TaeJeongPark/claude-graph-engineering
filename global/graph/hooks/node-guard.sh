#!/usr/bin/env bash
# PreToolUse(Bash) — graph-implementer 프런트매터에서 등록한다. 그 노드가 실행되는 동안만 동작한다.
# 구현 노드들은 작업 트리 하나를 공유한다. 트리 전체를 되돌리거나 히스토리를 만드는 명령은
# 같은 시각에 다른 노드가 하던 작업을 지우거나 섞으므로 막는다.
# 정규식 기반의 안전망이다. 의도적인 우회까지 막지는 못한다.
command -v jq >/dev/null 2>&1 || { echo "graph node-guard: jq가 없어 검사를 건너뜁니다." >&2; exit 0; }

cmd="$(jq -r '.tool_input.command // empty')"
[ -n "$cmd" ] || exit 0

deny() {
  jq -n --arg r "$1" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r}}'
  exit 0
}
has() { grep -Eiq -- "$1" <<<"$cmd"; }

# "git [전역 옵션] <서브커맨드>" 형태만 본다. 서브커맨드 자리에 있어야 하므로 `git grep reset` 은 걸리지 않고,
# git 앞에 무엇이 오든(환경 변수, sudo, then, bash -c ") 걸린다. 그 대가로 따옴표 안의 문구도 걸릴 수 있다.
git_sub() {
  has "(^|[^[:alnum:]_./-])git([[:space:]]+(-[Cc][[:space:]]+[^[:space:]]+|--?[[:alnum:]-]+(=[^[:space:]]+)?))*[[:space:]]+($1)([^[:alnum:]_-]|\$)"
}

git_sub 'commit|push|pull|merge|rebase|cherry-pick|revert|am|stash|reset|clean|switch' \
  && deny "그래프 노드는 작업 트리를 다른 노드와 공유합니다. 커밋·pull·stash·reset·브랜치 전환은 하지 않습니다. 커밋은 그래프가 끝난 뒤 사람이 합니다."
git_sub 'checkout|restore' \
  && deny "git checkout/restore 는 다른 노드가 고친 파일을 되돌릴 수 있습니다. 되돌릴 내용은 직접 편집하세요."
has '((^|[[:space:]/;&|])flyway[[:space:]]+([^;&|]*[[:space:]])?(migrate|clean|repair)|flyway:(migrate|clean|repair)|flyway(Migrate|Clean)([^[:alnum:]]|$)|liquibase[^;&|]*[[:space:]:](update|drop-all|dropAll)|alembic[[:space:]]+([^;&|]*[[:space:]])?(upgrade|downgrade)|prisma[[:space:]]+(migrate[[:space:]]+(deploy|reset|dev)|db[[:space:]]+push)|manage\.py[[:space:]]+migrate([[:space:]]|$))' \
  && deny "그래프 노드는 마이그레이션을 작성만 하고 적용하지 않습니다."
exit 0
