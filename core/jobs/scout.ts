import { randomUUID } from 'node:crypto'
import { config } from '../config'
import { audit, query, type Connection } from '../db'
import { closeReservation, reserveBudget } from '../budget'
import { model, searchQuery } from '../providers'
import { demoIdea, demoIdeaCritique } from '../providers/demo'
import {
  POLICY,
  ideaSchemaForEvidence,
  ideaSourceDomains,
  reviewSchema,
  validateIdea,
  type Evidence,
} from '../policy'
import { enqueue, type Job } from '../queue'
import { categoryById, isTaxonomyTopic, topicById } from '../taxonomy'
import { serviceCatalog } from '../service-catalog'
import { defaultParams, ensureStrategyParams, parseParams } from '../agents'
import { findDuplicate, ideaFingerprint, jaccard, rankScore, recentIdeas } from '../ideas'
import { maybeScheduleEvolution } from '../evolution'
import { withLease } from './lease'

/** What the farm can launch by itself. Same rules for the scout, the critic and the owner. */
export const farmRules = [
  'Результат это текст или текстовый файл.',
  'Текст делается из того, что прислал покупатель, без фактов о конкретных людях и компаниях.',
  'Нет физической работы, личного контакта, лицензии и регулируемых советов.',
  'Сервер может проверить результат по структуре и исходнику.',
  'Выдача занимает минуты, а себестоимость укладывается в лимит заказа.',
]

/**
 * One scout: two server searches on an assigned taxonomy topic, one idea from the scout, one
 * critique, then server-side duplicates and rank. The idea is saved with status `new`; the
 * daily report changes statuses.
 */
export async function scout(job: Job) {
  const topicId = job.payload.topicId
  if (!isTaxonomyTopic(topicId)) throw new Error('POLICY_TOPIC_UNKNOWN')
  const topic = topicById[topicId]!
  await ensureStrategyParams()
  const [strategy] = await query('SELECT * FROM strategies WHERE id=$1', [job.payload.strategyId])
  if (!strategy) throw new Error('INPUT_STRATEGY_UNKNOWN')
  if (strategy.status !== 'active') {
    await audit('scout_skipped', 'Разведка отменена: агент уже уволен отбором.', {
      jobId: job.id,
      agentId: strategy.id,
    })
    return
  }
  if ((await query('SELECT id FROM ideas WHERE job_id=$1', [job.id])).length) return
  // Hard daily cap on ideas, whoever asked for the scouting.
  const [today] = await query(
    `SELECT count(*)::int AS n FROM ideas
     WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
  )
  if ((today!.n as number) >= POLICY.maxIdeasPerDay) {
    await audit('scout_skipped', 'Разведка пропущена: дневной лимит идей исчерпан.', {
      jobId: job.id,
      agentId: strategy.id,
      limit: POLICY.maxIdeasPerDay,
    })
    return
  }
  const params = parseParams(strategy.params) ?? defaultParams(0)
  const demo = config().MODEL_PROVIDER === 'demo'
  const reservationId = await reserveBudget(`scout:${job.id}`, 'scout')
  const evidence: Evidence[] = []
  for (const [index, phrase] of topic.queries.slice(0, 2).entries())
    for (const item of await searchQuery(phrase, `${job.id}:search:${index}`, reservationId))
      if (!evidence.some((e) => e.url === item.url)) evidence.push(item)
  evidence.splice(12)
  const domains = new Set(evidence.map((e) => new URL(e.url).hostname.replace(/^www\./, '')))
  if (!demo && domains.size < 2) {
    await closeReservation(reservationId)
    throw new Error('SEARCH_INSUFFICIENT_SOURCES')
  }
  const [memory, previousByAgent] = await Promise.all([
    query(
      `SELECT title,critique->>'verdict' AS verdict,critique->>'reason' AS reason
       FROM ideas WHERE topic_id=$1 ORDER BY created_at DESC LIMIT 5`,
      [topicId],
    ),
    query(
      `SELECT count(*)::int AS n FROM ideas WHERE strategy_id=$1 AND generation=(SELECT generation FROM system_state WHERE id=true)`,
      [strategy.id],
    ),
  ])
  const context = {
    topic: {
      id: topic.id,
      industry: categoryById[topic.category]!.label,
      label: topic.label,
      audience: topic.audience,
      demandHints: topic.hints,
    },
    agent: {
      tone: params.tone,
      ideaScope: params.ideaScope,
      riskAppetite: params.riskAppetite,
      evidenceMinimum: params.evidenceMinimum,
    },
    evidence,
    memory: {
      previousIdeas: memory,
      instruction: memory.length
        ? 'Эти идеи по теме уже были. Предложи другой угол, не повторяй их под новым названием.'
        : 'По этой теме идей ещё не было.',
    },
    farm: {
      services: serviceCatalog.map((s) => ({
        template: s.id,
        label: s.label,
        delivery: s.delivery,
      })),
      canDoItselfOnlyIf: farmRules,
    },
    task: `Найди одну легальную идею заработка в теме «${topic.label}» для аудитории «${topic.audience}». Опиши аудиторию, проблему, признаки спроса (каждый со ссылкой из evidence, не меньше ${params.evidenceMinimum} из разных доменов, если они есть), конкурентов, модель дохода, стартовые и ежемесячные расходы в рублях, риски и быстрый способ проверить спрос. Честно оцени farmExecutable: true только если идею полностью закрывает одна из services и выполнены все правила canDoItselfOnlyIf, тогда укажи её template в suggestedTemplate. Иначе farmExecutable=false, suggestedTemplate=null и дай план запуска для человека в launchPlanForHuman: каждый шаг одно действие человека (где зарегистрироваться, что подтвердить, что оплатить или отправить), один честный аккаунт на человека, без обхода правил площадок. Не выдумывай спрос: конкурент в выдаче не доказывает продажи. Неизвестное перечисли в uncertainties.`,
  }
  const raw = await model({
    role: 'Разведчик',
    key: `${job.id}:idea`,
    reservationId,
    context,
    schema: ideaSchemaForEvidence(evidence, demo),
    demoValue: demoIdea({ topic, evidence, params, previousOnTopic: memory.length }),
  })
  const idea = validateIdea(raw, evidence, demo, topicId)
  const fingerprint = ideaFingerprint(idea.title, idea.audience)
  const recent = await recentIdeas()
  const duplicateOf = findDuplicate(fingerprint, recent)
  const similar = recent
    .filter((row) => jaccard(fingerprint, row.fingerprint) >= 0.3)
    .slice(0, 5)
    .map((row) => ({ title: row.title, verdict: row.verdict }))
  let critique = await model({
    role: 'Критик',
    key: `${job.id}:critic`,
    reservationId,
    context: {
      topic: { label: topic.label, audience: topic.audience },
      idea,
      evidence,
      similarIdeas: similar,
      farmRules,
      task: 'Оспорь идею. Ищи бесплатную замену, слабые признаки спроса, выдуманные факты, недопустимую тему и завышенную оценку исполнимости фермой. Если идея повторяет одну из similarIdeas под другим названием, верни REVISE или BLOCKED. PASS: аудитория и проблема понятны, признаки спроса опираются на источники, быстрый тест реален. REVISE: исправимый недостаток. BLOCKED: запрещённая тема или нет оснований. PASS не доказывает спрос.',
    },
    schema: reviewSchema,
    demoValue: demoIdeaCritique({
      params,
      previousByAgent: previousByAgent[0]!.n as number,
      duplicate: !!duplicateOf,
    }),
  })
  if (duplicateOf && critique.verdict === 'PASS')
    critique = {
      verdict: 'REVISE',
      reason: 'Повтор уже найденной идеи. Нужен другой угол.',
    }
  const rank = rankScore({
    verdict: critique.verdict,
    domains: ideaSourceDomains(idea),
    farmExecutable: idea.farmExecutable,
    startupCostRub: idea.startupCostRub,
    demandSignals: idea.demandSignals.length,
  })
  const ideaId = randomUUID()
  const saved = await withLease(job, async (db, window) => {
    // Selection may have run while the model answered: re-read the agent and the generation
    // under the same lock the selection takes.
    const [current] = await query('SELECT status FROM strategies WHERE id=$1', [strategy.id], db)
    if (current?.status !== 'active') {
      await audit(
        'scout_skipped',
        'Разведка не сохранена: агент уволен отбором, пока шёл поиск.',
        { jobId: job.id, agentId: strategy.id },
        db,
      )
      return false
    }
    const rows = await query(
      `INSERT INTO ideas(id,job_id,strategy_id,generation,topic_id,category,title,fingerprint,duplicate_of,
         research,evidence,critique,farm_executable,suggested_template,rank_score,status,is_demo)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'new',$16)
       ON CONFLICT(job_id,topic_id) DO NOTHING RETURNING id`,
      [
        ideaId,
        job.id,
        strategy.id,
        window.generation,
        topic.id,
        topic.category,
        idea.title,
        fingerprint,
        duplicateOf,
        idea,
        JSON.stringify(evidence),
        critique,
        idea.farmExecutable,
        idea.suggestedTemplate,
        rank,
        demo,
      ],
      db,
    )
    if (!rows.length) return false
    await audit(
      'idea_found',
      `Разведчик нашёл идею: ${idea.title}.`,
      {
        ideaId,
        agentId: strategy.id,
        title: idea.title,
        topicId: topic.id,
        category: topic.category,
        sources: ideaSourceDomains(idea),
        isDemo: demo,
      },
      db,
    )
    await audit(
      'idea_reviewed',
      `Критик: ${critique.verdict}. ${critique.reason}`,
      {
        ideaId,
        agentId: strategy.id,
        title: idea.title,
        verdict: critique.verdict,
        reason: critique.reason,
        duplicateOf,
        isDemo: demo,
      },
      db,
    )
    await maybeScheduleEvolution(db, new Date().toISOString().slice(0, 10))
    await reportAfterManualScouts(job, db)
    return true
  })
  await closeReservation(reservationId)
  return saved ? ideaId : null
}

/**
 * Owner scouting works without the schedule: after the last scout of a manual batch the
 * manager report runs too, so ideas get statuses and the best ones go to research.
 */
async function reportAfterManualScouts(job: Job, db: Connection) {
  const [self] = await query('SELECT dedupe_key FROM jobs WHERE id=$1', [job.id], db)
  if (!String(self?.dedupe_key).startsWith('scout-manual:')) return
  const [other] = await query(
    `SELECT id FROM jobs WHERE kind='scout' AND dedupe_key LIKE 'scout-manual:%'
     AND status IN ('queued','running') AND id<>$1 LIMIT 1`,
    [job.id],
    db,
  )
  if (other) return
  const reportKey = `report:after-scouts:${job.id}`
  await enqueue('report', reportKey, { kind: 'daily', reportKey }, db)
}
