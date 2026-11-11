// 반증 노드가 전부 결과를 내지 못하는 경우. 결함은 반증된 것이 아니라 unverified 로 돌아와야 한다.
const finding = (file, line, severity) => ({ severity, file, line, summary: file + ':' + line, path: '경로', suggestion: '제안' })

export default (prompt, opts) => {
  const label = opts.label
  if (label === 'scope') return { description: '픽스처 변경', diffCommand: 'git diff', files: ['a.ts', 'b.ts'] }
  if (label === 'find:correctness') return { findings: [finding('a.ts', 10, 'high'), finding('b.ts', 5, 'low')], checked: '' }
  if (label.startsWith('find:')) return { findings: [], checked: '' }
  if (label.startsWith('refute:')) return null
  return undefined
}
