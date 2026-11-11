// graph-build 시뮬레이션용 픽스처.
// 그래프: T1 → T2, T1 → T3, (T2, T3) → T4, T5(독립이지만 T2 와 쓰기 범위가 겹침), T6 → T7 (T6 은 blocked)
// T3 은 첫 검증에서 실패하고 한 번 고친 뒤 통과한다. 최종 게이트는 첫 리뷰에서 high 결함이 나오고 수정 뒤 통과한다.
const task = (id, deps, files) => ({ id, title: `작업 ${id}`, detail: '', deps, files, acceptance: ['조건'], verify: 'true' })
const seen = {}
const nth = (key) => (seen[key] = (seen[key] || 0) + 1)

export default (prompt, opts) => {
  const label = opts.label
  if (label === 'plan') {
    return {
      summary: '픽스처 계획',
      blocked: '',
      verifyCommand: 'make check',
      tasks: [
        task('T1', [], ['src/core/types.ts']),
        task('T2', ['T1'], ['src/api/']),
        task('T3', ['T1'], ['src/web/list.tsx']),
        task('T4', ['T2', 'T3'], ['src/e2e/list.spec.ts']),
        task('T5', [], ['src/api/health.ts']),
        task('T6', [], ['docs/a.md']),
        task('T7', ['T6'], ['docs/b.md']),
      ],
    }
  }
  if (label.startsWith('impl:') || label.startsWith('fix:')) {
    const id = label.split(':')[1]
    if (id === 'T6') return { status: 'blocked', summary: '', filesChanged: [], notes: '범위 밖 파일 수정이 필요하다' }
    return { status: 'done', summary: `${id} 구현`, filesChanged: [`changed/${id}`], notes: `${id} 메모` }
  }
  if (label.startsWith('verify:')) {
    const ids = [...prompt.matchAll(/"id": "(T\d+)"/g)].map((m) => m[1])
    return {
      tasks: ids.map((id) => (id === 'T3' && nth('verify-T3') === 1 ? { id, pass: false, failures: '타입 에러' } : { id, pass: true, failures: '' })),
      unrelated: '',
    }
  }
  if (label.startsWith('gate:verify')) return { pass: true, command: 'make check', failures: [] }
  if (label.startsWith('gate:review')) {
    return nth('review') === 1
      ? { findings: [{ severity: 'high', file: 'src/api/list.ts', line: 10, summary: '커서 검증 누락', path: '음수 커서', suggestion: '검증 추가' }], checked: '' }
      : { findings: [{ severity: 'low', file: 'src/web/list.tsx', line: 3, summary: '사소함', path: '-', suggestion: '-' }], checked: '' }
  }
  return undefined
}
