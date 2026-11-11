// graph-review 시뮬레이션용 픽스처.
// 두 관점이 같은 위치(a.ts:10, a.ts:12)를 보고 → 하나로 합쳐진다. b.ts:5 는 3표 중 2표가 반증해 탈락한다.
const finding = (file, line, severity) => ({ severity, file, line, summary: `${file}:${line}`, path: '경로', suggestion: '제안' })

export default (prompt, opts) => {
  const label = opts.label
  if (label === 'scope') return { description: '픽스처 변경', diffCommand: 'git diff', files: ['a.ts', 'b.ts'] }
  if (label === 'find:correctness') return { findings: [finding('a.ts', 10, 'high')], checked: '' }
  if (label === 'find:security') return { findings: [finding('a.ts', 12, 'medium'), finding('b.ts', 5, 'low')], checked: '' }
  if (label.startsWith('find:')) return { findings: [], checked: '' }
  if (label.startsWith('refute:')) {
    const [, item, vote] = label.split(':')
    // 심각도 순으로 정렬되므로 1번이 a.ts, 2번이 b.ts 다.
    return { refuted: item === '2' && vote !== '1', evidence: '근거' }
  }
  return undefined
}
