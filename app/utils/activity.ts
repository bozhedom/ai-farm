export type StageCall = {
  role: string
  status: string
}

export function stageState(
  role: string,
  calls: StageCall[],
  activeRoles: string[],
  online: boolean,
  finished: boolean,
) {
  const last = calls.filter((call) => call.role === role).at(-1)
  if (online && activeRoles.includes(role)) return 'working'
  if (last?.status === 'done') return 'complete'
  if (last?.status === 'uncertain') return 'issue'
  if (last?.status === 'pending') return 'unconfirmed'
  return finished ? 'skipped' : 'waiting'
}

export const stageLabels = {
  working: 'Работает сейчас',
  complete: 'Этап завершён',
  issue: 'Нужна проверка',
  unconfirmed: 'Нет подтверждения',
  skipped: 'Не запускался',
  waiting: 'Ожидает этапа',
}
