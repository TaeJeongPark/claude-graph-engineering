// resume: 모든 작업이 이전 실행에서 통과했지만 최종 게이트는 실패했던 경우. 게이트를 다시 판정해야 한다.
export default (prompt, opts) => {
  const label = opts.label
  if (label === 'plan') {
    return {
      summary: '이어가기 픽스처',
      blocked: '',
      verifyCommand: 'make check',
      tasks: [{ id: 'T1', title: '작업', detail: '', deps: [], files: ['a.ts'], acceptance: ['조건'], verify: 'true', done: true }],
    }
  }
  if (label.startsWith('gate:verify')) return { pass: false, command: 'make check', failures: [{ check: 'test', detail: '실패', files: ['a.ts'] }] }
  if (label.startsWith('gate:review')) return { findings: [], checked: '' }
  if (label.startsWith('fix:')) return { status: 'blocked', summary: '', filesChanged: [], notes: '범위 밖' }
  return undefined
}
