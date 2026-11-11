export const meta = {
  name: 'my-graph',
  description: '<권한 확인 창에 보이는 한 줄 설명>',
  whenToUse: '<언제 쓰는지. args 로 받는 값: 문자열 또는 {target, maxItems, model, models}>',
  phases: [
    { title: '탐색', detail: '작업 목록을 찾는다' },
    { title: '처리', detail: '항목마다 처리하고 판정한다' },
  ],
}

// ── 입력: 문자열과 객체를 모두 받는다. 필수 값이 없으면 에이전트를 띄우기 전에 끝낸다.
const input = typeof args === 'string' ? { target: args } : args || {}
const TARGET = (input.target || '').trim()
if (!TARGET) return { status: 'NO_TARGET', message: 'args 에 대상을 넘긴다.' }
const MAX_ITEMS = input.maxItems || 20 // 병렬 폭과 사이클에는 항상 상한을 둔다

// ── 노드: 역할 → 서브에이전트 타입. 모델은 지정하지 않으면 세션 모델을 상속한다.
const node = (role, agentType, opts) => {
  const o = { agentType, ...opts }
  const m = (input.models || {})[role] || input.model
  if (m) o.model = m
  return o
}

// ── 상태 계약: 다음 노드나 분기 조건이 쓰는 값은 스키마로 받는다.
const ITEMS_SCHEMA = {
  type: 'object',
  properties: { items: { type: 'array', items: { type: 'string' } } },
  required: ['items'],
}
const RESULT_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, detail: { type: 'string' } },
  required: ['ok', 'detail'],
}

// ── 1. 탐색 (읽기 전용 노드)
phase('탐색')
const found = await agent(`${TARGET} 에서 처리할 항목을 찾는다. 파일을 고치지 않는다.`, node('scout', 'graph-analyst', { label: 'scout', phase: '탐색', schema: ITEMS_SCHEMA }))
if (!found) return { status: 'FAILED', stage: 'scout' }
if (!found.items.length) return { status: 'NOTHING_TO_DO' } // 0건이면 뒤 단계를 건너뛴다
const items = found.items.slice(0, MAX_ITEMS)
if (found.items.length > items.length) log(`${found.items.length}건 중 ${MAX_ITEMS}건만 처리한다.`) // 버린 것은 알린다

// ── 2. 처리: 항목마다 독립이므로 pipeline. 항목 A 가 판정 중일 때 항목 B 는 아직 처리 중일 수 있다.
const results = await pipeline(
  items,
  (item, _, i) => agent(`다음 항목을 처리한다: ${item}`, node('worker', 'graph-analyst', { label: `work:${i + 1}`, phase: '처리', schema: RESULT_SCHEMA })),
  // 게이트: 처리한 노드와 다른 노드가 판정한다.
  (work, item, i) =>
    agent(`다음 처리 결과가 맞는지 직접 확인한다.\n항목: ${item}\n결과: ${JSON.stringify(work)}`, node('judge', 'graph-analyst', { label: `judge:${i + 1}`, phase: '처리', schema: RESULT_SCHEMA })).then((verdict) => ({
      item,
      work,
      verdict,
    })),
)

// ── 3. 보고: 실패(null)도 숨기지 않는다.
const done = results.filter(Boolean)
return {
  status: done.length === items.length ? 'DONE' : 'PARTIAL',
  passed: done.filter((r) => r.verdict && r.verdict.ok).map((r) => r.item),
  failed: done.filter((r) => !r.verdict || !r.verdict.ok).map((r) => ({ item: r.item, detail: r.verdict ? r.verdict.detail : '판정 노드 실패' })),
  lost: items.length - done.length,
  dropped: found.items.slice(MAX_ITEMS),
}
