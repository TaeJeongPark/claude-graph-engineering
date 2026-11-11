export const meta = {
  name: 'graph-investigate',
  description: '문제를 재현한 뒤 서로 다른 관점의 가설을 병렬로 세우고, 가설마다 증거로 확인·기각해 근본 원인을 판정한다 (읽기 전용)',
  whenToUse:
    '원인이 분명하지 않은 버그·테스트 실패·성능 저하를 진단할 때. 코드를 고치지 않고 원인과 최소 수정 방향만 보고한다. args: 증상 문자열 또는 {problem, check, lenses, maxHypotheses, model, models}.',
  phases: [
    { title: '재현', detail: '증상을 재현하고 관찰 사실을 수집' },
    { title: '가설', detail: '관점별로 독립된 가설을 생성' },
    { title: '증거', detail: '가설마다 확인 또는 기각할 증거를 수집' },
    { title: '판정', detail: '증거로 근본 원인을 고르고 수정 방향을 제시' },
  ],
}

const input = typeof args === 'string' ? { problem: args } : args || {}
const PROBLEM = (input.problem || '').trim()
if (!PROBLEM) return { status: 'NO_PROBLEM', message: '증상이 비어 있다. args 에 증상 문자열이나 {problem} 을 넘긴다.' }
const CHECK = (input.check || '').trim()
// 상한은 호출자가 무엇을 넘기든 정수 범위 안으로 맞춘다. 범위를 벗어난 값이 사이클을 끝나지 않게 만들 수 있다.
const int = (v, def, min, max) => {
  const n = Math.floor(Number(v))
  return v == null || !Number.isFinite(n) ? def : Math.min(max, Math.max(min, n))
}
const MAX_HYPOTHESES = int(input.maxHypotheses, 6, 1, 20)
const node = (role, opts) => {
  const o = { agentType: 'graph-analyst', ...opts }
  const m = (input.models || {})[role] || input.model
  if (m) o.model = m
  return o
}

const ALL_LENSES = {
  change: '최근 변경 — git log / blame 으로 증상과 관련된 최근 커밋, 의존성·설정 변경을 본다',
  logic: '코드 경로 — 증상이 나는 지점에서 거꾸로 호출 경로와 데이터 흐름을 따라간다',
  state: '데이터·상태 — 입력 데이터, DB 상태, 캐시, 순서·타이밍·동시성에 따라 달라지는 동작을 본다',
  env: '환경 — 설정, 환경 변수, 버전, 플랫폼 차이, 외부 서비스, 테스트 격리를 본다',
}
const LENSES = [].concat(input.lenses || Object.keys(ALL_LENSES)).filter((l) => ALL_LENSES[l])
if (!LENSES.length) return { status: 'NO_LENSES', message: `lenses 는 ${Object.keys(ALL_LENSES).join(', ')} 중에서 고른다.` }

const STR = { type: 'string' }
const REPRO_SCHEMA = {
  type: 'object',
  properties: {
    reproduced: { type: 'boolean' },
    command: { type: 'string', description: '증상을 재현하는 명령. 재현하지 못했으면 시도한 명령' },
    observations: { type: 'string', description: '관찰한 사실만: 에러 메시지, 스택, 실패한 단정, 수치. 해석은 넣지 않는다' },
  },
  required: ['reproduced', 'command', 'observations'],
}
const HYPOTHESES_SCHEMA = {
  type: 'object',
  properties: {
    hypotheses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string', description: '원인에 대한 주장 한 문장' },
          location: { type: 'string', description: '의심하는 파일:줄 또는 설정' },
          test: { type: 'string', description: '이 가설이 맞으면 관찰돼야 하고 틀리면 관찰되지 않을 것' },
        },
        required: ['claim', 'location', 'test'],
      },
    },
  },
  required: ['hypotheses'],
}
const EVIDENCE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'refuted', 'inconclusive'] },
    evidence: { type: 'string', description: '읽은 코드 위치, 실행한 명령과 결과' },
  },
  required: ['verdict', 'evidence'],
}
const DIAGNOSIS_SCHEMA = {
  type: 'object',
  properties: {
    rootCause: { type: 'string', description: '근본 원인. 증거로 정할 수 없으면 빈 문자열' },
    location: STR,
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    fix: { type: 'string', description: '최소 수정 방향. 코드를 고치지는 않는다' },
    verify: { type: 'string', description: '수정 후 고쳐졌는지 판정할 명령' },
    open: { type: 'string', description: '확인하지 못한 것, 다음에 볼 것' },
  },
  required: ['rootCause', 'location', 'confidence', 'fix', 'verify', 'open'],
}

const facts = (r) => `증상: ${PROBLEM}
재현: ${r.reproduced ? `됨 — \`${r.command}\`` : `안 됨 (시도: \`${r.command}\`)`}
관찰:
${r.observations}`

// ── 1. 재현
phase('재현')
const repro = await agent(
  `다음 문제를 재현하고 관찰한 사실을 수집한다. 원인을 추측하지 않고, 파일을 고치지 않는다.

증상: ${PROBLEM}
${CHECK ? `재현 명령: ${CHECK}` : '재현 명령이 주어지지 않았다. 관련 테스트나 실행 방법을 찾아 직접 재현한다.'}`,
  node('repro', { label: 'reproduce', phase: '재현', schema: REPRO_SCHEMA }),
)
if (!repro) return { status: 'FAILED', stage: 'reproduce', message: '재현 노드가 결과를 내지 못했다.' }
if (!repro.reproduced) log('재현하지 못했다. 관찰 사실만으로 가설을 세운다.')

// ── 2. 가설: 관점마다 독립 생성. 중복 제거에 전체가 필요하므로 한 번 모은다.
const proposed = await parallel(
  LENSES.map((l) => () =>
    agent(
      `다음 문제의 원인 가설을 한 가지 관점에서만 세운다. 파일을 고치지 않는다.

${facts(repro)}

관점: ${ALL_LENSES[l]}

- 코드를 실제로 읽고, 관찰 사실을 설명할 수 있는 가설만 최대 2개 낸다. 이 관점에서 그럴듯한 원인이 없으면 빈 목록을 낸다.
- 가설마다 맞고 틀림을 가를 수 있는 구체적인 확인 방법(test)을 적는다.`,
      node('hypothesis', { label: `hypothesize:${l}`, phase: '가설', schema: HYPOTHESES_SCHEMA }),
    ).then((r) => (r ? r.hypotheses.slice(0, 2).map((h) => ({ ...h, lens: l })) : null)),
  ),
)
// 같은 위치를 가리키는 가설은 하나로 본다.
const hypotheses = []
for (const h of proposed.filter(Boolean).flat()) {
  if (!hypotheses.some((x) => x.location && x.location === h.location)) hypotheses.push(h)
}
if (!hypotheses.length) {
  return { status: 'NO_HYPOTHESIS', problem: PROBLEM, reproduced: repro.reproduced, command: repro.command, observations: repro.observations }
}
const tested = hypotheses.slice(0, MAX_HYPOTHESES)
if (hypotheses.length > tested.length) log(`가설 ${hypotheses.length}개 중 ${MAX_HYPOTHESES}개만 확인한다. 나머지는 untested 로 반환한다.`)

// ── 3. 증거: 가설마다 독립적으로 확인한다. 가설 생성자와 다른 노드가 본다.
const examined = await pipeline(tested, (h, _, i) =>
  agent(
    `다음 가설이 맞는지 증거로 판정한다. 가설을 세운 사람의 설명은 믿지 말고 직접 확인한다. 파일을 고치지 않는다.

${facts(repro)}

가설: ${h.claim}
의심 위치: ${h.location}
확인 방법: ${h.test}

- 확인 방법을 실제로 수행한다(코드 읽기, 명령 실행, 로그 확인). 임시 스크립트가 필요하면 저장소 밖 임시 디렉터리에 만든다.
- 가설이 관찰 사실 전부를 설명하면 confirmed, 모순되는 증거가 있으면 refuted, 확인할 수 없으면 inconclusive.`,
    node('evidence', { label: `test:${i + 1}:${h.lens}`, phase: '증거', schema: EVIDENCE_SCHEMA }),
  ).then((e) => ({ ...h, ...(e || { verdict: 'inconclusive', evidence: '증거 노드가 결과를 내지 못했다.' }) })),
)
const results = examined.filter(Boolean)

// ── 4. 판정
const diagnosis = await agent(
  `조사 결과를 종합해 근본 원인을 판정한다. 파일을 고치지 않는다.

${facts(repro)}

가설과 증거:
${JSON.stringify(results, null, 2)}

- confirmed 가설이 여럿이면 어느 것이 근본 원인이고 어느 것이 결과인지 가린다. 필요하면 코드를 직접 확인한다.
- confirmed 가 없으면 rootCause 를 비우고, 가장 유력한 방향과 다음에 확인할 것을 open 에 적는다. 추측을 원인으로 쓰지 않는다.
- fix 는 원인을 고치는 최소 수정 방향이다. 증상만 가리는 수정은 제안하지 않는다.`,
  node('judge', { label: 'judge', phase: '판정', schema: DIAGNOSIS_SCHEMA }),
)

return {
  status: diagnosis && diagnosis.rootCause ? 'DIAGNOSED' : 'UNDETERMINED',
  problem: PROBLEM,
  reproduced: repro.reproduced,
  command: repro.command,
  diagnosis,
  hypotheses: results.map((h) => ({ lens: h.lens, claim: h.claim, location: h.location, verdict: h.verdict, evidence: h.evidence })),
  untested: hypotheses.slice(MAX_HYPOTHESES).map((h) => ({ lens: h.lens, claim: h.claim, location: h.location })),
}
