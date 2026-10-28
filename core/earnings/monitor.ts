import { randomUUID } from 'node:crypto'
import { audit, query, transaction } from '../db'
import { EARNINGS_POLICY as P } from '../policy'
import type { EarningsView } from '../contracts/earnings'
import { fetchOpportunityResearch } from '../opportunities/research'
import type { OpportunityResearch } from '../opportunities/types'
import { fetchArbitrageResearch, type ArbitrageReport } from './arbitrage'

interface MonitorRow {
  enabled: boolean
  requested_at: Date | null
  attempted_at: Date | null
  finished_at: Date | null
  lease_id: string | null
  lease_until: Date | null
  report: OpportunityResearch | null
  arbitrage: ArbitrageReport | null
  error: string
}
async function ensureMonitor() {
  await query('INSERT INTO earnings_monitor(id) VALUES(true) ON CONFLICT DO NOTHING')
}

function arbitrageFetchedAt(row: MonitorRow | null | undefined) {
  const raw = row?.arbitrage?.fetchedAt
  const at = raw ? Date.parse(raw) : NaN
  return Number.isFinite(at) ? at : 0
}

function nextRefreshAt(row: MonitorRow, now: number) {
  const fullDue = (row.attempted_at?.getTime() || 0) + P.intervalMs
  const arbDue = arbitrageFetchedAt(row) + P.arbitrageIntervalMs
  return new Date(Math.max(now, Math.min(fullDue, arbDue))).toISOString()
}

export async function earningsView(): Promise<EarningsView> {
  await ensureMonitor()
  const [row] = await query<MonitorRow>('SELECT * FROM earnings_monitor WHERE id=true')
  const [worker] = await query('SELECT worker_heartbeat FROM system_state WHERE id=true')
  const now = Date.now()
  const running = !!row!.lease_until && row!.lease_until.getTime() > now
  return {
    monitor: {
      enabled: row!.enabled,
      pending: !!row!.requested_at && !running,
      running,
      workerAlive: !!worker?.worker_heartbeat && now - worker.worker_heartbeat.getTime() < 90_000,
      attemptedAt: row!.attempted_at?.toISOString() || null,
      finishedAt: row!.finished_at?.toISOString() || null,
      nextAt: row!.enabled && !row!.requested_at ? nextRefreshAt(row!, now) : null,
      error: row!.error,
      intervalMinutes: P.intervalMs / 60_000,
      arbitrageIntervalMinutes: P.arbitrageIntervalMs / 60_000,
    },
    report: row!.report,
    arbitrage: row!.arbitrage,
  }
}

export async function controlEarnings(action: 'enable' | 'pause' | 'refresh') {
  await ensureMonitor()
  await transaction(async (db) => {
    const [row] = await query<MonitorRow>(
      'SELECT * FROM earnings_monitor WHERE id=true FOR UPDATE',
      [],
      db,
    )
    if (action === 'pause') {
      await query(
        'UPDATE earnings_monitor SET enabled=false,requested_at=NULL WHERE id=true',
        [],
        db,
      )
    } else {
      const recent = row!.attempted_at && Date.now() - row!.attempted_at.getTime() < P.retryMs
      const running = row!.lease_until && row!.lease_until.getTime() > Date.now()
      if (action === 'refresh' && recent && !running && !row!.requested_at)
        throw new Error('EARNINGS_REFRESH_COOLDOWN')
      await query(
        'UPDATE earnings_monitor SET enabled=CASE WHEN $1 THEN true ELSE enabled END,requested_at=CASE WHEN $2 THEN coalesce(requested_at,now()) ELSE requested_at END WHERE id=true',
        [action === 'enable', !recent && !running],
        db,
      )
    }
    await audit('earnings_monitor_control', 'Изменён мониторинг открытых данных.', { action }, db)
  })
  return earningsView()
}

/** Keep the last successful snapshot visibly unavailable; failure never renews its timestamps. */
export function preserveUnavailable(
  previous: OpportunityResearch | null,
  next: OpportunityResearch,
) {
  return {
    ...next,
    feeds: next.feeds.map((feed) => {
      const old = previous?.feeds.find((v) => v.id === feed.id)
      return feed.status === 'unavailable' && old?.items.length
        ? { ...feed, items: old.items, fetchedAt: old.fetchedAt, expiresAt: old.expiresAt }
        : feed
    }),
  }
}

async function refreshArbitrageOnly(
  dependencies: { arbitrage: () => Promise<ArbitrageReport> },
  row: MonitorRow,
) {
  const now = Date.now()
  if (!row.enabled) return false
  if (row.lease_until && row.lease_until.getTime() > now) return false
  if (now - arbitrageFetchedAt(row) < P.arbitrageIntervalMs) return false
  // Claim a short lease so a concurrent full tick cannot race the arb-only write.
  const lease = randomUUID()
  const [claimed] = await query<MonitorRow>(
    `UPDATE earnings_monitor SET lease_id=$1,lease_until=now()+$2*interval '1 millisecond'
     WHERE id=true AND enabled AND (lease_until IS NULL OR lease_until<=now())
       AND (arbitrage IS NULL OR coalesce((arbitrage->>'fetchedAt')::timestamptz, to_timestamp(0))
            <= now()-$3*interval '1 millisecond')
     RETURNING *`,
    [lease, Math.min(P.leaseMs, P.arbitrageIntervalMs), P.arbitrageIntervalMs],
  )
  if (!claimed) return false
  try {
    const quotes = await dependencies.arbitrage()
    const updated = await query(
      `UPDATE earnings_monitor SET arbitrage=$2,lease_id=NULL,lease_until=NULL
       WHERE id=true AND lease_id=$1 AND lease_until>now() RETURNING id`,
      [lease, quotes],
    )
    return updated.length > 0
  } catch {
    await query(
      `UPDATE earnings_monitor SET lease_id=NULL,lease_until=NULL
       WHERE id=true AND lease_id=$1`,
      [lease],
    )
    return false
  }
}

export async function earningsTick(
  dependencies = {
    research: fetchOpportunityResearch,
    arbitrage: fetchArbitrageResearch,
  },
) {
  await ensureMonitor()
  const lease = randomUUID()
  const [claimed] = await query<MonitorRow>(
    `UPDATE earnings_monitor SET lease_id=$1,lease_until=now()+$2*interval '1 millisecond',attempted_at=now()
     WHERE id=true AND (lease_until IS NULL OR lease_until<=now())
       AND (requested_at IS NOT NULL OR (enabled AND (attempted_at IS NULL OR attempted_at<=now()-$3*interval '1 millisecond')))
     RETURNING *`,
    [lease, P.leaseMs, P.intervalMs],
  )
  if (!claimed) {
    const [row] = await query<MonitorRow>('SELECT * FROM earnings_monitor WHERE id=true')
    return row ? refreshArbitrageOnly(dependencies, row) : false
  }
  const [research, arbitrage] = await Promise.allSettled([
    dependencies.research(),
    dependencies.arbitrage(),
  ])
  const failed = research.status === 'rejected' || arbitrage.status === 'rejected'
  const report =
    research.status === 'fulfilled'
      ? preserveUnavailable(claimed.report, research.value)
      : claimed.report
  const quotes = arbitrage.status === 'fulfilled' ? arbitrage.value : claimed.arbitrage
  // A stale worker cannot overwrite the result of a newer claim after its lease expires.
  const updated = await query(
    `UPDATE earnings_monitor SET report=$2,arbitrage=$3,error=$4,finished_at=now(),requested_at=NULL,lease_id=NULL,lease_until=NULL
     WHERE id=true AND lease_id=$1 AND lease_until>now() RETURNING id`,
    [lease, report, quotes, failed ? 'EARNINGS_SOURCE_FAILED' : ''],
  )
  return updated.length > 0
}
