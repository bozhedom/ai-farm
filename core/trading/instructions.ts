import { createHash } from 'node:crypto'
import { z } from 'zod'
import { audit, query, transaction } from '../db'
import { config } from '../config'
import { closeReservation, reserveBudget } from '../budget'
import {
  prepareProfile,
  profileSchema,
  savePreparedProfile,
  withPreparedProfile,
} from '../agent-profiles'
import { model, prepareModelRequest } from '../providers'
import { TRADING_INSTRUCTION_POLICY as P } from '../policy'
import {
  defaultTradingRules,
  describeTradingRules,
  instructionInterpretationSchema,
  type ApplyInstructionsResult,
  type InstructionInterpretation,
} from '../contracts/trading-instructions'
import { tradingInstructions, validateTradingRules } from './owner-rules'

export const applyInstructionsSchema = profileSchema
  .extend({
    role: z.literal('manager'),
    requestId: z.uuid(),
    instructionsRevision: z.number().int().nonnegative(),
  })
  .strict()
type Input = z.infer<typeof applyInstructionsSchema>

/** Exact, whole-line commands need no model. Never ignore the unrecognised remainder. */
export function parseTradingInstructions(text: string): InstructionInterpretation | null {
  const rules = defaultTradingRules()
  const seen = new Set<string>()
  for (const raw of text
    .split(/[;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    const line = raw.toLowerCase().replace(/ё/g, 'е').replace(/[.!]$/, '').trim()
    let key = '',
      value: unknown,
      match: RegExpMatchArray | null
    if (/^(?:приостановить|запретить) новые покупки$/.test(line)) {
      key = 'pauseEntries'
      value = true
    } else if (
      (match = line.match(/^(не покупать|покупать только|торговать только) ([a-z0-9и, /-]+)$/))
    ) {
      const parts = match[2]!.split(/\s*(?:,| и )\s*/)
      if (parts.some((s) => !/^[a-z0-9]{2,20}(?:[-/]usdt)?$/.test(s))) return null
      key = match[1] === 'не покупать' ? 'blockedSymbols' : 'allowedSymbols'
      value = [...new Set(parts.map((s) => s.toUpperCase().replace(/[-/]USDT$/, '') + '-USDT'))]
    } else if (
      (match = line.match(
        /^(?:сделка|новая покупка|покупка) (?:не больше|не более|до) (\d+(?:[.,]\d+)?) usdt$/,
      ))
    ) {
      key = 'maxOrderUsdt'
      value = match[1]!.replace(',', '.')
    } else if ((match = line.match(/^не более (\d+) (?:заявок|сделок) в день$/))) {
      key = 'maxOrdersPerDay'
      value = Number(match[1])
    } else if ((match = line.match(/^пауза между покупками (\d+) минут(?:ы|у)?$/))) {
      key = 'entryIntervalMinutes'
      value = Number(match[1])
    } else if ((match = line.match(/^держать позицию не дольше (\d+) минут(?:ы|у)?$/))) {
      key = 'maxHoldingMinutes'
      value = Number(match[1])
    } else if (
      (match = line.match(
        /^(стоп-лосс|тейк-профит|экспозиция не более) (\d+(?:[.,]\d{1,2})?)\s*%$/,
      ))
    ) {
      key =
        match[1] === 'стоп-лосс'
          ? 'positionStopBps'
          : match[1] === 'тейк-профит'
            ? 'takeProfitBps'
            : 'maxExposureBps'
      const [whole, fraction = ''] = match[2]!.replace(',', '.').split('.')
      value = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
    } else return null
    if (seen.has(key)) return null
    seen.add(key)
    Object.assign(rules, { [key]: value })
  }
  return { rules: validateTradingRules(rules), managerNotes: [], issues: [] }
}

export type InstructionInterpreter = (
  text: string,
  requestId: string,
  reservationId: string,
) => Promise<unknown>
function interpretationArgs(text: string, requestId: string, reservationId: string) {
  return {
    role: 'Разбор торговых инструкций',
    key: `trading-instructions:${requestId}`,
    reservationId,
    schema: instructionInterpretationSchema,
    context: {
      task: 'Проверь и переведи инструкцию владельца. В issues перечисли всё, что нельзя исполнить. Применяются только поля строгой схемы.',
      instruction: text,
    },
    demoValue: {
      rules: defaultTradingRules(),
      managerNotes: [],
      issues: [
        'Свободную формулировку нужно разобрать настоящей моделью. В demo доступны точные команды из примеров.',
      ],
    },
    maxOutputTokens: P.maxOutputTokens,
  }
}
const interpret: InstructionInterpreter = (text, requestId, reservationId) =>
  model(interpretationArgs(text, requestId, reservationId))

async function claim(input: Input) {
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  return transaction(async (db) => {
    await query('SELECT pg_advisory_xact_lock(735100)', [], db)
    const [old] = await query(
      'SELECT * FROM trading_instruction_requests WHERE id=$1',
      [input.requestId],
      db,
    )
    if (old) {
      if (old.request_hash !== hash) throw new Error('IDEMPOTENCY_CONFLICT')
      if (old.status === 'done') return old.response as ApplyInstructionsResult
      if (old.status === 'failed' || Date.now() - old.created_at.getTime() > P.leaseMs)
        throw new Error('TRADING_INSTRUCTIONS_EXPIRED')
      throw new Error('TRADING_INSTRUCTIONS_BUSY')
    }
    const [profile] = await query(
      "SELECT revision FROM agent_profiles WHERE role='manager'",
      [],
      db,
    )
    const current = await tradingInstructions(db)
    if (
      current.revision !== input.instructionsRevision ||
      (profile?.revision ?? 0) !== input.revision
    )
      throw new Error('PROFILE_CHANGED')
    const [limit] = await query(
      `SELECT count(*) FILTER(WHERE created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS n,
      coalesce(bool_or(status='running' AND created_at>clock_timestamp()-$1*interval '1 millisecond'),false) AS busy FROM trading_instruction_requests`,
      [P.leaseMs],
      db,
    )
    if (limit!.busy) throw new Error('TRADING_INSTRUCTIONS_BUSY')
    if (limit!.n >= P.maxDailyRequests) throw new Error('TRADING_INSTRUCTIONS_DAILY_LIMIT')
    await query(
      "INSERT INTO trading_instruction_requests(id,request_hash,status) VALUES($1,$2,'running')",
      [input.requestId, hash],
      db,
    )
    return null
  })
}

/** Compile outside transactions, then commit both the executable settings and manager text. */
export async function applyTradingInstructions(
  value: unknown,
  interpreter: InstructionInterpreter = interpret,
): Promise<ApplyInstructionsResult> {
  const input = applyInstructionsSchema.parse(value)
  const cached = await claim(input)
  if (cached) return cached
  let reservationId: string | undefined
  try {
    const { requestId, instructionsRevision, ...profile } = input
    const prepared = await prepareProfile(profile)
    let parsed = parseTradingInstructions(input.instruction)
    const source = parsed ? 'parser' : 'model'
    if (!parsed) {
      if (config().MODEL_PROVIDER === 'demo')
        parsed = interpretationArgs(input.instruction, requestId, '').demoValue
      else
        parsed = await withPreparedProfile(prepared, async () => {
          const [state] = await query('SELECT mode FROM system_state WHERE id=true')
          if (state?.mode === 'emergency_stop') throw new Error('STOPPED')
          if (
            prepareModelRequest(interpretationArgs(input.instruction, requestId, '')).maximum >
            P.reserveKopecks
          )
            throw new Error('TRADING_INSTRUCTIONS_TOO_EXPENSIVE')
          reservationId = await reserveBudget(
            `trading-instructions:${requestId}`,
            'trading_instructions',
          )
          return instructionInterpretationSchema.parse(
            await interpreter(input.instruction, requestId, reservationId),
          )
        })
    }
    const rules = validateTradingRules(parsed.rules)
    if (
      input.instruction &&
      !parsed.issues.length &&
      !parsed.managerNotes.length &&
      !describeTradingRules(rules).length
    )
      parsed.issues.push(
        'В тексте не распознано ни одного применимого правила. Уточните желаемое поведение.',
      )
    return await transaction(async (db) => {
      await query('SELECT pg_advisory_xact_lock(735097)', [], db)
      await query(
        'INSERT INTO trading_instructions(id) VALUES(true) ON CONFLICT DO NOTHING',
        [],
        db,
      )
      const [row] = await query(
        'SELECT revision FROM trading_instructions WHERE id=true FOR UPDATE',
        [],
        db,
      )
      const [request] = await query(
        'SELECT status,created_at FROM trading_instruction_requests WHERE id=$1 FOR UPDATE',
        [requestId],
        db,
      )
      if (request?.status !== 'running' || Date.now() - request.created_at.getTime() > P.leaseMs)
        throw new Error('TRADING_INSTRUCTIONS_EXPIRED')
      if (row!.revision !== instructionsRevision) throw new Error('PROFILE_CHANGED')
      if (!parsed.issues.length) {
        await savePreparedProfile(prepared, db)
        await query(
          `UPDATE trading_instructions SET rules=$1,manager_notes=$2,source=$3,revision=revision+1,
          profile_revision=$4,applied_at=now() WHERE id=true`,
          [rules, JSON.stringify(parsed.managerNotes), source, input.revision + 1],
          db,
        )
        await audit(
          'trading_instructions_applied',
          'Текст владельца применён к спотовым трейдерам и торговому менеджеру.',
          {
            requestId,
            revision: instructionsRevision + 1,
            source,
            rules,
            instructionHash: createHash('sha256').update(input.instruction).digest('hex'),
          },
          db,
        )
      }
      const response: ApplyInstructionsResult = {
        applied: !parsed.issues.length,
        issues: parsed.issues,
        current: await tradingInstructions(db),
      }
      if (reservationId) await closeReservation(reservationId, db)
      await query(
        "UPDATE trading_instruction_requests SET status='done',response=$2,finished_at=now() WHERE id=$1",
        [requestId, response],
        db,
      )
      return response
    })
  } catch (error) {
    await transaction(async (db) => {
      if (reservationId) await closeReservation(reservationId, db)
      await query(
        "UPDATE trading_instruction_requests SET status='failed',finished_at=now() WHERE id=$1 AND status='running'",
        [input.requestId],
        db,
      )
    })
    throw error
  }
}
