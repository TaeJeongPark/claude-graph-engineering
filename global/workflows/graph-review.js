export const meta = {
  name: 'graph-review',
  description: '변경을 관점별로 나눠 병렬로 결함을 찾고, 결함마다 반증을 시도해 살아남은 것만 보고한다 (읽기 전용)',
  whenToUse:
    'PR 전이나 큰 변경 뒤에 근거 있는 결함만 추려 받고 싶을 때. args: 리뷰 범위 문자열(브랜치, 커밋 범위, 경로) 또는 {scope, dimensions, votes, maxFindings, model, models}. 범위를 생략하면 미커밋 변경과 기본 브랜치 대비 변경을 본다.',
  phases: [
    { title: '범위', detail: '리뷰할 변경과 파일을 확정' },
    { title: '탐지', detail: '관점별 리뷰어가 서로의 결과를 모른 채 병렬로 탐지' },
    { title: '반증', detail: '결함마다 독립 검증자가 반증을 시도' },
  ],
}

const input = typeof args === 'string' ? { scope: args } : args || {}
const SCOPE = (input.scope || '').trim()
// 상한은 호출자가 무엇을 넘기든 정수 범위 안으로 맞춘다. 범위를 벗어난 값이 사이클을 끝나지 않게 만들 수 있다.
const int = (v, def, min, max) => {
  const n = Math.floor(Number(v))
  return v == null || !Number.isFinite(n) ? def : Math.min(max, Math.max(min, n))
}
const VOTES = int(input.votes, 1, 1, 9)
const MAX_FINDINGS = int(input.maxFindings, 20, 1, 100)
const modelOf = (role) => (input.models || {})[role] || input.model
const node = (role, agentType, opts) => {
  const o = { agentType, ...opts }
  if (modelOf(role)) o.model = modelOf(role)
  return o
}

const ALL_DIMENSIONS = {
  correctness: '정확성 — 경계값, null·빈 컬렉션, 동시성, 트랜잭션 경계, 에러 처리 누락, 호출부와의 계약 불일치',
  security: '보안 — 인젝션, 인증·인가 누락, 비밀값 노출, 검증되지 않은 외부 입력',
  data: '데이터·성능 — N+1, 인덱스 없는 조회, 락을 오래 잡는 마이그레이션, 하위 호환이 깨지는 스키마·API 변경',
  tests: '테스트 — 변경된 동작을 검증하는 테스트가 있는가, 테스트가 구현을 베끼지 않았는가, 무력화된 테스트',
}
const DIMENSIONS = [].concat(input.dimensions || Object.keys(ALL_DIMENSIONS)).filter((d) => ALL_DIMENSIONS[d])
if (!DIMENSIONS.length) {
  return { status: 'NO_DIMENSIONS', message: `dimensions 는 ${Object.keys(ALL_DIMENSIONS).join(', ')} 중에서 고른다.` }
}

const STR = { type: 'string' }
const SCOPE_SCHEMA = {
  type: 'object',
  properties: {
    description: { type: 'string', description: '무엇을 리뷰하는가 한 줄' },
    diffCommand: { type: 'string', description: '리뷰어가 변경을 볼 때 쓸 명령. git 저장소가 아니면 빈 문자열' },
    files: { type: 'array', items: STR },
  },
  required: ['description', 'diffCommand', 'files'],
}
const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          file: STR,
          line: { type: 'integer' },
          summary: STR,
          path: { type: 'string', description: '어떤 입력·상태에서 무엇이 잘못되는가' },
          suggestion: STR,
        },
        required: ['severity', 'file', 'line', 'summary', 'path', 'suggestion'],
      },
    },
    checked: STR,
  },
  required: ['findings', 'checked'],
}
const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean' },
    evidence: { type: 'string', description: '판정 근거: 읽은 코드 위치, 실행한 명령과 결과' },
  },
  required: ['refuted', 'evidence'],
}

// ── 1. 범위
phase('범위')
const scope = await agent(
  `코드 리뷰의 범위를 확정한다. 파일을 고치지 않는다.

요청된 범위: ${SCOPE || '(지정 없음) 미커밋 변경과, 기본 브랜치에서 갈라진 뒤의 커밋을 합친 변경'}

- git 저장소면 해당 변경을 정확히 보여 주는 diff 명령 하나를 diffCommand 에 적는다(예: \`git diff $(git merge-base HEAD origin/HEAD)\`). 실행해서 동작을 확인한다.
- files 에는 변경된 파일을 적는다. 생성물, lockfile, 바이너리는 뺀다.
- 변경이 없으면 files 를 비운다.`,
  node('scope', 'graph-analyst', { label: 'scope', phase: '범위', schema: SCOPE_SCHEMA, effort: 'low' }),
)
if (!scope) return { status: 'FAILED', stage: 'scope', message: '범위 노드가 결과를 내지 못했다.' }
if (!scope.files.length) return { status: 'NOTHING_TO_REVIEW', scope: scope.description, confirmed: [] }

// ── 2. 탐지: 관점마다 독립 리뷰어. 중복 제거에 전체 결과가 필요하므로 여기서 한 번 모은다.
const found = await parallel(
  DIMENSIONS.map((d) => () =>
    agent(
      `다음 변경을 한 가지 관점으로만 리뷰한다.

- 범위: ${scope.description}
- 변경 보기: ${scope.diffCommand || '(git 없음) 아래 파일을 직접 읽는다'}
- 파일: ${scope.files.join(', ')}
- 관점: ${ALL_DIMENSIONS[d]}

다른 관점의 문제는 다른 리뷰어가 본다. 이 관점에서 실제로 일어나는 경로를 추적할 수 있는 결함만 보고한다.`,
      node('reviewer', 'graph-reviewer', { label: `find:${d}`, phase: '탐지', schema: FINDINGS_SCHEMA }),
    ).then((r) => (r ? r.findings.map((f) => ({ ...f, dimension: d })) : null)),
  ),
)
const failedDimensions = DIMENSIONS.filter((_, i) => !found[i])
if (failedDimensions.length) log(`결과를 내지 못한 관점: ${failedDimensions.join(', ')}`)

// 같은 파일의 가까운 줄(±3)을 가리키는 결함은 같은 것으로 보고 심각도가 높은 쪽을 남긴다.
const rank = { high: 0, medium: 1, low: 2 }
const sorted = found
  .filter(Boolean)
  .flat()
  .sort((a, b) => rank[a.severity] - rank[b.severity])
const unique = []
for (const f of sorted) {
  const dup = unique.find((u) => u.file === f.file && Math.abs(u.line - f.line) <= 3)
  if (dup) dup.dimension = [...new Set(`${dup.dimension},${f.dimension}`.split(','))].join(',')
  else unique.push(f)
}
const candidates = unique.slice(0, MAX_FINDINGS)
if (unique.length > candidates.length) {
  log(`후보 ${unique.length}건 중 심각도 순 ${MAX_FINDINGS}건만 검증한다. 나머지 ${unique.length - candidates.length}건은 dropped 로 반환한다.`)
}

// ── 3. 반증: 결함마다 VOTES 명이 독립적으로 반증을 시도한다. 과반이 반증하지 못해야 살아남는다.
const judged = await pipeline(candidates, (f, _, i) =>
  parallel(
    Array.from({ length: VOTES }, (_, k) => () =>
      agent(
        `코드 리뷰에서 다음 결함이 보고됐다. 이것이 틀렸음을 보이려고 시도한다.

${JSON.stringify(f, null, 2)}

- 해당 코드와 호출부를 직접 읽고, 가능하면 테스트나 명령을 실행해 확인한다. 파일은 고치지 않는다.
- 보고된 경로가 실제로는 일어날 수 없거나(상위에서 이미 검증, 도달 불가), 이번 변경 전부터 있던 문제이거나, 취향 문제면 refuted=true.
- 경로가 실제로 일어남을 확인했을 때만 refuted=false. 확신할 수 없으면 refuted=true.`,
        node('verifier', 'graph-analyst', { label: `refute:${i + 1}${VOTES > 1 ? `:${k + 1}` : ''}`, phase: '반증', schema: VERDICT_SCHEMA }),
      ),
    ),
  ).then((votes) => {
    const cast = votes.filter(Boolean)
    const upheld = cast.filter((v) => !v.refuted)
    return { ...f, votes: `${upheld.length}/${cast.length}`, verified: cast.length > 0, confirmed: upheld.length * 2 > cast.length, evidence: (upheld[0] || cast[0] || { evidence: '검증자가 결과를 내지 못했다.' }).evidence }
  }),
)

// 검증자가 한 명도 판정하지 못한 결함은 반증된 것이 아니다. 따로 돌려준다.
const done = judged.map((j, i) => j || { ...candidates[i], votes: '0/0', verified: false, confirmed: false, evidence: '검증 노드가 결과를 내지 못했다.' })
const unverified = done.filter((f) => !f.verified)
return {
  status: failedDimensions.length || unverified.length ? 'PARTIAL' : 'DONE',
  scope: scope.description,
  dimensions: DIMENSIONS,
  failedDimensions,
  confirmed: done.filter((f) => f.verified && f.confirmed),
  unverified,
  refuted: done.filter((f) => f.verified && !f.confirmed).map((f) => ({ file: f.file, line: f.line, summary: f.summary, evidence: f.evidence })),
  dropped: unique.slice(MAX_FINDINGS).map((f) => ({ severity: f.severity, file: f.file, line: f.line, summary: f.summary })),
}
