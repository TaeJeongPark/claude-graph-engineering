export const meta = {
  name: 'graph-build',
  description: '요구사항을 작업 DAG로 분해해 의존 순서대로 병렬 구현하고, 웨이브별 검증·수정 사이클과 최종 게이트(전체 검증 + 독립 리뷰)를 거친다',
  whenToUse:
    '여러 파일·모듈에 걸친 구현을 한 세션에서 병렬로 끝내고 싶을 때. args: 요구사항 문자열 또는 {request, planOnly, plan, resume, outDir, maxTasks, maxParallel, maxFixRounds, review, model, models}.',
  phases: [
    { title: '계획', detail: '요구사항 → 작업 DAG (의존 관계, 쓰기 범위, 인수 조건)' },
    { title: '구현', detail: '의존이 풀리고 쓰기 범위가 겹치지 않는 작업을 웨이브 단위로 병렬 실행' },
    { title: '검증', detail: '웨이브가 끝난 조용한 트리에서 작업별 판정' },
    { title: '수정', detail: '실패한 작업만 재작업 (횟수 상한)' },
    { title: '최종 게이트', detail: '전체 검증 + 작성자와 독립된 리뷰' },
  ],
}

// ─────────────────────────────────────────────────────────────
// 입력
// ─────────────────────────────────────────────────────────────
const input = typeof args === 'string' ? { request: args } : args || {}
const REQUEST = (input.request || '').trim()
const RESUME = !!input.resume
if (!REQUEST && !RESUME && !input.plan) {
  return { status: 'NO_REQUEST', message: '요구사항이 비어 있다. args 에 요구사항 문자열이나 {request} 를 넘긴다.' }
}
const slug =
  REQUEST.toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'run'
if (RESUME && !input.outDir) {
  return { status: 'NO_OUTDIR', message: 'resume 에는 이어갈 실행의 outDir 이 필요하다 (예: .claude/graph/runs/<이름>).' }
}
const OUT = input.outDir || `.claude/graph/runs/${slug}`
// 상한은 호출자가 무엇을 넘기든 정수 범위 안으로 맞춘다. 범위를 벗어난 값이 사이클을 끝나지 않게 만들 수 있다.
const int = (v, def, min, max) => {
  const n = Math.floor(Number(v))
  return v == null || !Number.isFinite(n) ? def : Math.min(max, Math.max(min, n))
}
const MAX_TASKS = int(input.maxTasks, 12, 1, 50)
const MAX_PARALLEL = int(input.maxParallel, 4, 1, 16)
const MAX_FIX = int(input.maxFixRounds, 2, 0, 5)
const REVIEW = input.review !== false

// 노드(역할) → 서브에이전트 타입. 모델은 지정하지 않으면 세션 모델을 상속한다.
const NODE = {
  planner: 'graph-planner',
  implementer: 'graph-implementer',
  verifier: 'graph-verifier',
  reviewer: 'graph-reviewer',
}
const node = (role, opts) => {
  const o = { agentType: NODE[role], ...opts }
  const m = (input.models || {})[role] || input.model
  if (m) o.model = m
  return o
}

// ─────────────────────────────────────────────────────────────
// 엣지를 따라 흐르는 상태의 계약 (JSON Schema)
// ─────────────────────────────────────────────────────────────
const STR = { type: 'string' }
const STRS = { type: 'array', items: STR }
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    summary: STR,
    blocked: { type: 'string', description: '사람의 결정이 필요해 계획을 세울 수 없으면 그 이유. 아니면 빈 문자열' },
    verifyCommand: { type: 'string', description: '전체 변경을 판정하는 프로젝트 검증 명령' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'T1, T2 처럼 짧은 고유 ID' },
          title: STR,
          detail: { type: 'string', description: '무엇을 어디에 어떻게. 이 작업만 받은 사람이 구현할 수 있을 만큼' },
          deps: { ...STRS, description: '먼저 끝나야 하는 작업 ID' },
          files: { ...STRS, description: '이 작업이 만들거나 고치는 파일·디렉터리(쓰기 범위)' },
          acceptance: { ...STRS, description: '관찰 가능한 인수 조건' },
          verify: { type: 'string', description: '이 작업만 판정하는 명령. 없으면 빈 문자열' },
          done: { type: 'boolean', description: 'resume 에서 이미 통과한 작업이면 true' },
        },
        required: ['id', 'title', 'detail', 'deps', 'files', 'acceptance', 'verify'],
      },
    },
  },
  required: ['summary', 'blocked', 'verifyCommand', 'tasks'],
}
const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'blocked'] },
    summary: STR,
    filesChanged: STRS,
    notes: { type: 'string', description: '다음 노드가 알아야 할 것. blocked 면 이유와 필요한 것' },
  },
  required: ['status', 'summary', 'filesChanged', 'notes'],
}
const WAVE_VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: STR,
          pass: { type: 'boolean' },
          failures: { type: 'string', description: '실패한 명령과 핵심 출력, 충족하지 못한 인수 조건. 통과면 빈 문자열' },
        },
        required: ['id', 'pass', 'failures'],
      },
    },
    unrelated: { type: 'string', description: '이 작업들과 무관한 기존 실패. 없으면 빈 문자열' },
  },
  required: ['tasks', 'unrelated'],
}
const GATE_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    command: STR,
    failures: {
      type: 'array',
      items: {
        type: 'object',
        properties: { check: STR, detail: STR, files: STRS },
        required: ['check', 'detail', 'files'],
      },
    },
  },
  required: ['pass', 'command', 'failures'],
}
const REVIEW_SCHEMA = {
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
    checked: { type: 'string', description: '확인한 범위와 실행한 검사' },
  },
  required: ['findings', 'checked'],
}

// ─────────────────────────────────────────────────────────────
// 계획 검증: 스키마가 잡지 못하는 그래프 속성(고유 ID, 의존 존재, 비순환)
// ─────────────────────────────────────────────────────────────
function validatePlan(p) {
  const errs = []
  const ids = new Set()
  // 사람이 손으로 쓴 계획(args.plan)은 스키마 검증을 거치지 않았다.
  if (!p || !Array.isArray(p.tasks)) return ['계획에 tasks 배열이 없다.']
  for (const t of p.tasks) {
    if (!t || typeof t.id !== 'string' || !t.id) errs.push('id 가 없는 작업이 있다.')
    else if (!Array.isArray(t.deps) || !Array.isArray(t.files)) errs.push(`${t.id} 의 deps 와 files 는 배열이어야 한다.`)
  }
  if (errs.length) return errs
  if (!p.tasks.length) errs.push('작업이 하나도 없다.')
  if (p.tasks.length > MAX_TASKS) errs.push(`작업이 ${p.tasks.length}개로 상한 ${MAX_TASKS}개를 넘는다. 더 큰 단위로 묶는다.`)
  for (const t of p.tasks) {
    if (ids.has(t.id)) errs.push(`ID 중복: ${t.id}`)
    ids.add(t.id)
  }
  for (const t of p.tasks) {
    for (const d of t.deps) {
      if (d === t.id) errs.push(`${t.id} 가 자기 자신에 의존한다.`)
      else if (!ids.has(d)) errs.push(`${t.id} 의 의존 ${d} 가 없는 작업이다.`)
    }
  }
  if (!errs.length) {
    // Kahn: 의존이 모두 제거된 작업을 반복해서 떼어 낸다. 남는 것이 있으면 순환이다.
    const left = new Map(p.tasks.map((t) => [t.id, new Set(t.deps)]))
    for (let moved = true; moved; ) {
      moved = false
      for (const [id, deps] of left) {
        if (deps.size) continue
        left.delete(id)
        for (const other of left.values()) other.delete(id)
        moved = true
      }
    }
    if (left.size) errs.push(`의존 관계에 순환이 있다: ${[...left.keys()].join(', ')}`)
  }
  return errs
}

// 쓰기 범위 충돌: 같은 경로이거나 한쪽이 다른 쪽의 상위 디렉터리면 겹친다.
const norm = (f) =>
  f
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\*.*$/, '')
    .replace(/\/+$/, '')
const overlaps = (a, b) => a === b || a === '' || b === '' || a.startsWith(b + '/') || b.startsWith(a + '/')
const conflict = (t, u) => t.files.some((a) => u.files.some((b) => overlaps(norm(a), norm(b))))

// 준비된 작업 중 쓰기 범위가 서로 겹치지 않는 것만 계획 순서대로 고른다.
// 쓰기 범위를 밝히지 않은 작업은 무엇과 겹칠지 알 수 없으므로 혼자 실행한다.
function pickBatch(ready) {
  const batch = []
  for (const t of ready) {
    if (batch.length >= MAX_PARALLEL) break
    if (!t.files.length) {
      if (!batch.length) batch.push(t)
      break
    }
    if (!batch.some((u) => conflict(t, u))) batch.push(t)
  }
  return batch
}

// ─────────────────────────────────────────────────────────────
// 프롬프트
// ─────────────────────────────────────────────────────────────
const taskBlock = (t) => JSON.stringify({ id: t.id, title: t.title, detail: t.detail, files: t.files, acceptance: t.acceptance, verify: t.verify }, null, 2)

const planPrompt = (errors) =>
  RESUME
    ? `중단된 그래프 실행을 이어간다. \`${OUT}/plan.json\` 과 \`${OUT}/progress.md\` 를 읽는다.
plan.json 의 계획을 그대로 반환하되, progress.md 에 PASS 로 기록됐고 실제 코드에도 반영돼 있는 작업은 done=true 로 표시한다. 계획 내용은 바꾸지 않는다. 파일이 없으면 blocked 에 그 사실을 적는다.`
    : `다음 요구사항을 구현하기 위한 작업 그래프(DAG)를 설계한다.

요구사항:
${REQUEST}

- 먼저 관련 코드, 호출부, 테스트, 기존 패턴을 읽는다. 추측으로 경로를 만들지 않는다.
- 작업은 최대 ${MAX_TASKS}개. 한 작업은 한 에이전트가 한 번에 끝낼 크기로 쓴다.
- deps 에는 그 작업의 산출물(타입, 함수, 스키마, API 계약)을 실제로 써야 하는 경우만 넣는다. 의존이 적을수록 병렬로 실행된다.
- files(쓰기 범위)는 빠짐없이 적는다. 범위가 겹치는 작업은 동시에 실행되지 않는다. 여러 작업이 같은 파일을 고쳐야 하면 하나로 합치거나 deps 로 순서를 정한다.
- acceptance 는 관찰 가능한 조건으로, verify 는 그 작업만 판정하는 명령으로 쓴다.
- verifyCommand 는 프로젝트 CLAUDE.md 나 빌드 설정에서 찾은 전체 검증 명령이다.
- 사람의 결정 없이는 정할 수 없는 설계 선택이 있으면 추측하지 말고 blocked 에 적는다.
- 확정한 계획을 \`${OUT}/plan.json\` 에 같은 JSON 으로 저장한다. \`${OUT}/progress.md\` 가 이미 있으면 이전 실행의 기록이므로 비운다.${
        errors.length ? `\n\n직전 계획은 다음 이유로 거부됐다. 고쳐서 다시 낸다:\n- ${errors.join('\n- ')}` : ''
      }`

const implPrompt = (t, upstream) =>
  `작업 그래프의 노드 하나를 구현한다. 전체 계획은 \`${OUT}/plan.json\` 에 있다.

작업:
${taskBlock(t)}
${upstream ? `\n선행 작업이 남긴 메모:\n${upstream}\n` : ''}
- files 에 적힌 쓰기 범위 안에서만 파일을 만들거나 고친다. 다른 노드가 같은 시각에 다른 파일을 고치고 있다.
- 범위 밖을 바꿔야만 끝낼 수 있으면 바꾸지 말고 status=blocked 로 이유를 보고한다.
- 끝내기 전에 verify 명령(있으면)을 실행한다. 다른 노드가 작업 중인 파일에서 난 실패는 무시하고 notes 에 적는다.
- 커밋, push, 배포, 마이그레이션 적용은 하지 않는다.`

const fixPrompt = (t, failures) =>
  `구현한 작업이 검증을 통과하지 못했다. 원인을 찾아 고친다.

작업:
${taskBlock(t)}

검증 실패:
${failures}

- 쓰기 범위(files) 안에서만 고친다. 테스트를 지우거나 건너뛰거나 기대값을 결과에 맞추지 않는다.
- 범위 밖 문제이거나 인수 조건 자체가 잘못됐으면 status=blocked 로 보고한다.`

const waveVerifyPrompt = (tasks) =>
  `방금 구현된 작업들을 판정한다. 지금은 다른 노드가 파일을 고치지 않는다.

작업:
${tasks.map(taskBlock).join('\n')}

- 작업마다 verify 명령을 실행하고 acceptance 를 하나씩 코드와 실행 결과로 확인한다. 작성자의 보고는 근거로 쓰지 않는다.
- 실패가 어느 작업의 것인지 가린다. 이 작업들과 무관한 기존 실패는 unrelated 에 적고 작업을 실패로 판정하지 않는다.
- 파일을 고치지 않는다. 단, 판정 결과를 \`${OUT}/progress.md\` 끝에 작업당 한 줄씩 덧붙인다: \`- PASS <id> <제목>\` 또는 \`- FAIL <id> <제목> — <이유>\`.`

const gatePrompt = (cmd, changed) =>
  `전체 변경이 끝났다. 프로젝트 전체 검증을 실행하고 판정한다.

- 검증 명령: ${cmd || '(계획에 없음 — 프로젝트 CLAUDE.md 와 빌드 설정에서 타입 체크·린트·테스트 명령을 찾는다)'}
- 변경된 파일: ${changed.join(', ') || '(보고 없음 — git status 로 확인)'}
- 실패마다 어떤 검사가 왜 실패했는지와 관련 파일을 적는다. 변경과 무관한 기존 실패는 failures 에 넣지 않는다.
- 파일을 고치지 않는다.`

const reviewPrompt = (changed) =>
  `다음 파일들의 변경을 리뷰한다: ${changed.join(', ') || '(git status / git diff 로 확인)'}
변경의 의도는 \`${OUT}/plan.json\` 의 인수 조건으로만 판단한다.`

const gateFixPrompt = (gate, blocking) =>
  `최종 게이트를 통과하지 못했다. 아래 문제를 고친다. 계획은 \`${OUT}/plan.json\`.

${gate && !gate.pass ? `검증 실패:\n${JSON.stringify(gate.failures, null, 2)}\n` : ''}${
    blocking.length ? `리뷰에서 나온 심각도 높음 결함:\n${JSON.stringify(blocking, null, 2)}\n` : ''
  }
- 지적된 문제만 고친다. 테스트를 지우거나 건너뛰거나 기대값을 결과에 맞추지 않는다.
- 지적이 틀렸다고 판단하면 고치지 말고 notes 에 근거를 적는다.`

// ─────────────────────────────────────────────────────────────
// 1. 계획
// ─────────────────────────────────────────────────────────────
phase('계획')
let plan = null
let planErrors = []
if (input.plan && typeof input.plan === 'object') {
  planErrors = validatePlan(input.plan)
  if (planErrors.length) return { status: 'PLAN_INVALID', errors: planErrors }
  plan = input.plan
}
// 스키마는 통과했지만 그래프로서 성립하지 않는 계획은 이유를 붙여 한 번만 되돌려 보낸다.
for (let attempt = 1; !plan && attempt <= 2; attempt++) {
  const p = await agent(planPrompt(planErrors), node('planner', { label: attempt === 1 ? 'plan' : 'plan:retry', phase: '계획', schema: PLAN_SCHEMA }))
  if (!p) return { status: 'FAILED', stage: 'plan', message: '계획 노드가 결과를 내지 못했다.' }
  if (p.blocked) return { status: 'BLOCKED', stage: 'plan', reason: p.blocked, plan: p, outDir: OUT }
  planErrors = validatePlan(p)
  if (!planErrors.length) plan = p
}
if (!plan) return { status: 'PLAN_INVALID', errors: planErrors }
if (input.planOnly) {
  return { status: 'PLAN_ONLY', plan, outDir: OUT, next: '계획을 확인한 뒤 같은 args 에 {plan: <이 계획>} 을 넣어 다시 실행한다.' }
}

// ─────────────────────────────────────────────────────────────
// 2. 웨이브 실행: 구현(병렬) → 검증(조용한 트리) → 수정 사이클
// ─────────────────────────────────────────────────────────────
const tasks = plan.tasks
const state = {} // id → pending | pass | fail | blocked | skipped
const result = {} // id → { summary, notes, filesChanged, failures }
for (const t of tasks) {
  state[t.id] = t.done ? 'pass' : 'pending'
  result[t.id] = { summary: t.done ? '이전 실행에서 통과' : '', notes: '', filesChanged: [], failures: '' }
}
const record = (t, r) => {
  result[t.id].summary = r.summary
  result[t.id].notes = r.notes
  result[t.id].filesChanged = [...new Set([...result[t.id].filesChanged, ...r.filesChanged])]
}
const block = (t, why) => {
  state[t.id] = 'blocked'
  result[t.id].failures = why
  log(`${t.id} BLOCKED — ${why}`)
}

for (let wave = 1; ; wave++) {
  // 선행 작업이 실패한 작업은 실행하지 않는다. 건너뛴 것이 또 다른 작업을 막을 수 있으므로 고정점까지 반복한다.
  for (let changed = true; changed; ) {
    changed = false
    for (const t of tasks) {
      if (state[t.id] !== 'pending') continue
      const bad = t.deps.find((d) => state[d] !== 'pass' && state[d] !== 'pending')
      if (!bad) continue
      state[t.id] = 'skipped'
      result[t.id].failures = `선행 작업 ${bad} 가 ${state[bad]}`
      log(`${t.id} SKIPPED — 선행 작업 ${bad} 가 ${state[bad]}`)
      changed = true
    }
  }
  const ready = tasks.filter((t) => state[t.id] === 'pending' && t.deps.every((d) => state[d] === 'pass'))
  if (!ready.length) break
  const batch = pickBatch(ready)
  if (!batch.length) break
  log(`웨이브 ${wave}: ${batch.map((t) => t.id).join(', ')}${ready.length > batch.length ? ` (대기 ${ready.length - batch.length})` : ''}`)

  const built = await parallel(
    batch.map((t) => () => {
      const upstream = t.deps
        .map((d) => (result[d].notes ? `- ${d}: ${result[d].notes}` : ''))
        .filter(Boolean)
        .join('\n')
      return agent(implPrompt(t, upstream), node('implementer', { label: `impl:${t.id}`, phase: '구현', schema: IMPL_SCHEMA }))
    }),
  )
  let open = []
  batch.forEach((t, i) => {
    const r = built[i]
    if (!r) return block(t, '구현 노드가 결과를 내지 못했다.')
    record(t, r)
    if (r.status === 'blocked') return block(t, r.notes)
    open.push(t)
  })

  // 수정 사이클. 엣지: 검증 실패 → 수정 → 재검증. MAX_FIX 번을 넘기면 실패로 확정한다.
  for (let round = 0; open.length; round++) {
    const v = await agent(waveVerifyPrompt(open), node('verifier', { label: `verify:w${wave}${round ? `:r${round}` : ''}`, phase: '검증', schema: WAVE_VERIFY_SCHEMA }))
    const verdict = new Map(((v && v.tasks) || []).map((x) => [x.id, x]))
    const failed = []
    for (const t of open) {
      const x = verdict.get(t.id)
      if (x && x.pass) state[t.id] = 'pass'
      else failed.push({ t, failures: x ? x.failures : '검증 노드가 이 작업의 판정을 내지 않았다.' })
    }
    for (const f of failed) result[f.t.id].failures = f.failures
    if (!failed.length) break
    if (round >= MAX_FIX || !v) {
      for (const f of failed) {
        state[f.t.id] = 'fail'
        log(`${f.t.id} FAIL — ${v ? `수정 ${MAX_FIX}회 후에도 실패` : '검증 노드 실패'}`)
      }
      break
    }
    const fixed = await parallel(
      failed.map((f) => () => agent(fixPrompt(f.t, f.failures), node('implementer', { label: `fix:${f.t.id}:r${round + 1}`, phase: '수정', schema: IMPL_SCHEMA }))),
    )
    open = []
    failed.forEach((f, i) => {
      const r = fixed[i]
      if (!r) return block(f.t, '수정 노드가 결과를 내지 못했다.')
      record(f.t, r)
      if (r.status === 'blocked') return block(f.t, r.notes)
      open.push(f.t)
    })
  }
}

// ─────────────────────────────────────────────────────────────
// 3. 최종 게이트: 전체 검증 ∥ 독립 리뷰 → (실패) 수정 → 재판정
// ─────────────────────────────────────────────────────────────
const ran = tasks.filter((t) => !t.done && state[t.id] === 'pass')
// 이어서 실행할 때는 새로 통과한 작업이 없어도 판정한다. 이전 실행이 게이트에서 멈췄을 수 있다.
const runGate = ran.length > 0 || (RESUME && tasks.some((t) => state[t.id] === 'pass'))
let gate = null
let findings = []
let reviewed = false
let gateNote = ''
if (runGate) {
  let changed = [...new Set(tasks.flatMap((t) => result[t.id].filesChanged))]
  for (let round = 0; ; round++) {
    const suffix = round ? `:r${round}` : ''
    const [g, r] = await parallel([
      () => agent(gatePrompt(plan.verifyCommand, changed), node('verifier', { label: `gate:verify${suffix}`, phase: '최종 게이트', schema: GATE_SCHEMA })),
      () => (REVIEW ? agent(reviewPrompt(changed), node('reviewer', { label: `gate:review${suffix}`, phase: '최종 게이트', schema: REVIEW_SCHEMA })) : null),
    ])
    gate = g
    reviewed = !!r
    findings = r ? r.findings : []
    const blocking = findings.filter((f) => f.severity === 'high')
    if (!g) gateNote = '전체 검증 노드가 결과를 내지 못했다.'
    else if (REVIEW && !r) gateNote = '리뷰 노드가 결과를 내지 못해 리뷰 없이 판정했다.'
    else gateNote = ''
    if (!g || (g.pass && !blocking.length) || round >= MAX_FIX) break
    const fx = await agent(gateFixPrompt(g, blocking), node('implementer', { label: `fix:gate:r${round + 1}`, phase: '수정', schema: IMPL_SCHEMA }))
    if (!fx || fx.status === 'blocked') {
      gateNote = `게이트 수정이 중단됐다: ${fx ? fx.notes : '수정 노드가 결과를 내지 못했다.'}`
      break
    }
    changed = [...new Set([...changed, ...fx.filesChanged])]
  }
} else {
  log('이번 실행에서 통과한 작업이 없어 최종 게이트를 건너뛴다.')
}

// ─────────────────────────────────────────────────────────────
// 4. 보고
// ─────────────────────────────────────────────────────────────
const allPass = tasks.every((t) => state[t.id] === 'pass')
const gatePass = !runGate || (!!gate && gate.pass && !findings.some((f) => f.severity === 'high') && (!REVIEW || reviewed))
const count = (s) => tasks.filter((t) => state[t.id] === s).length
return {
  status: allPass && gatePass ? 'DONE' : 'INCOMPLETE',
  summary: plan.summary,
  outDir: OUT,
  counts: { total: tasks.length, pass: count('pass'), fail: count('fail'), blocked: count('blocked'), skipped: count('skipped') },
  tasks: tasks.map((t) => ({ id: t.id, title: t.title, state: state[t.id], summary: result[t.id].summary, failures: state[t.id] === 'pass' ? '' : result[t.id].failures })),
  gate: gate ? { pass: gate.pass, command: gate.command, failures: gate.failures } : null,
  gateNote,
  findings,
  next: allPass && gatePass ? '커밋은 하지 않았다. 변경을 확인한 뒤 커밋한다.' : `남은 문제를 해결한 뒤 {resume: true, outDir: "${OUT}"} 로 이어서 실행할 수 있다.`,
}
