// 작업 하나가 검증을 끝까지 통과하지 못하는 경우. 수정 사이클이 상한(기본 2회)에서 멈춰야 한다.
export default (prompt, opts) => {
  const label = opts.label
  if (label === 'plan') {
    return {
      summary: '실패 픽스처',
      blocked: '',
      verifyCommand: 'make check',
      tasks: [{ id: 'T1', title: '작업', detail: '', deps: [], files: ['a.ts'], acceptance: ['조건'], verify: 'true' }],
    }
  }
  if (label.startsWith('impl:') || label.startsWith('fix:')) return { status: 'done', summary: '', filesChanged: ['a.ts'], notes: '' }
  if (label.startsWith('verify:')) return { tasks: [{ id: 'T1', pass: false, failures: '계속 실패' }], unrelated: '' }
  return undefined
}
