import { audit, query, transaction, type Connection } from './db'
import { WorkerDraining } from './activity'
import {
  cryptoDirections,
  workFocusSchema,
  type WorkDirection,
  type WorkFocusView,
} from './contracts/work-focus'

/** A temporary filter. It never changes underlying switches, capital, stops or Live consent. */
export async function workFocus(db?: Connection, lock = false): Promise<WorkFocusView> {
  const [row] = await query(
    `SELECT *,enabled AND (until_at IS NULL OR until_at>clock_timestamp()) AS active FROM work_focus WHERE id=true${lock ? ' FOR SHARE' : ''}`,
    [],
    db,
  )
  return {
    enabled: row?.enabled ?? false,
    active: row?.active ?? false,
    selected: row?.selected ?? [...cryptoDirections],
    until: row?.until_at?.toISOString() ?? null,
    revision: row?.revision ?? 0,
  }
}
export const workAllowed = (focus: WorkFocusView, direction: WorkDirection) =>
  !focus.active || focus.selected.includes(direction)
export async function directionAllowed(direction: WorkDirection, db?: Connection) {
  return workAllowed(await workFocus(db), direction)
}
export class WorkFocusPaused extends WorkerDraining {
  constructor() {
    super()
    this.message = 'WORK_FOCUS_PAUSED'
  }
}
export async function assertDirectionAllowed(direction: WorkDirection, db?: Connection) {
  if (!workAllowed(await workFocus(db, !!db), direction)) throw new WorkFocusPaused()
}
export async function saveWorkFocus(value: unknown) {
  const input = workFocusSchema.parse(value)
  return transaction(async (db) => {
    await query('INSERT INTO work_focus(id) VALUES(true) ON CONFLICT DO NOTHING', [], db)
    const [row] = await query('SELECT revision FROM work_focus WHERE id=true FOR UPDATE', [], db)
    if (row!.revision !== input.revision) throw new Error('WORK_FOCUS_CHANGED')
    await query(
      `UPDATE work_focus SET enabled=$1,selected=$2,
       until_at=CASE WHEN $1 AND $3='day' THEN clock_timestamp()+interval '24 hours' ELSE NULL END,
       revision=revision+1,updated_at=now() WHERE id=true`,
      [input.enabled, input.selected, input.duration],
      db,
    )
    await audit(
      'work_focus_changed',
      input.enabled
        ? 'Владелец оставил новые запуски только выбранным направлениям.'
        : 'Владелец снял ограничение выбранных направлений. Прежние настройки и остановки сохранены.',
      { enabled: input.enabled, selected: input.selected, duration: input.duration },
      db,
    )
    return workFocus(db)
  })
}
