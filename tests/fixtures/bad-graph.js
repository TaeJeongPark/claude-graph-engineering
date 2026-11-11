const NAME = 'bad'
export const meta = { name: NAME, description: `설명 ${NAME}` }

// graph-check 가 거부해야 하는 것들: meta 앞의 코드, 리터럴이 아닌 meta, 비결정 호출
const started = Date.now()
return await agent('x', { label: String(started) })
