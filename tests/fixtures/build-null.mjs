// 구현 노드가 결과를 내지 못하는 경우(사용자가 건너뛰었거나 API 오류). null 은 예외가 아니라 blocked 로 이어져야 한다.
export default (prompt, opts) => {
  const label = opts.label
  if (label === 'plan') {
    return {
      summary: 'null 픽스처',
      blocked: '',
      verifyCommand: '',
      tasks: [{ id: 'T1', title: '작업', detail: '', deps: [], files: ['a.ts'], acceptance: [], verify: '' }],
    }
  }
  return null
}
