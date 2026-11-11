// graph-investigate 시뮬레이션용 픽스처. 두 관점이 같은 위치를 가리키면 하나만 확인한다.
export default (prompt, opts) => {
  const label = opts.label
  if (label === 'reproduce') return { reproduced: true, command: 'npm test', observations: 'TypeError' }
  if (label === 'hypothesize:change' || label === 'hypothesize:logic') {
    return { hypotheses: [{ claim: '널 처리 누락', location: 'a.ts:10', test: '널 입력으로 호출' }] }
  }
  if (label.startsWith('hypothesize:')) return { hypotheses: [] }
  if (label.startsWith('test:')) return { verdict: 'confirmed', evidence: '재현됨' }
  if (label === 'judge') return { rootCause: '널 처리 누락', location: 'a.ts:10', confidence: 'high', fix: '가드 추가', verify: 'npm test', open: '' }
  return undefined
}
