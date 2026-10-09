<script setup lang="ts">
import type { OfficeAgent, ScoreComponent } from '../../../core/contracts/office'
import { officeApi, useOfficeAction } from '~/composables/office/actions'
import { useOfficeAgents } from '~/composables/office/data'
import { day, plural, rub, withCount } from '~/composables/office/format'
import {
  agentAvatar,
  agentBadge,
  agentShort,
  mutationText,
  score100,
  scoreComponents,
} from '~/composables/office/labels'

useHead({ title: 'Агенты' })
const { data, status, pending, refresh } = useOfficeAgents()
const { busy, run } = useOfficeAction()

const all = computed(() => data.value?.agents || [])
const byId = computed(() => new Map(all.value.map((a) => [a.id, a])))
const nameOf = (id: string | null) => (id ? byId.value.get(id)?.name || 'другой агент' : '')
const indexOf = (agent: OfficeAgent) => all.value.indexOf(agent)

const scouts = computed(() =>
  [...all.value].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1
    return (b.score?.total ?? -1) - (a.score?.total ?? -1)
  }),
)
const stats = computed(() => {
  const list = all.value
  const active = list.filter((a) => a.status === 'active')
  const copies = list.filter((a) => a.parentId)
  return {
    active: active.length,
    archived: list.filter((a) => a.status === 'archived').length,
    copies: copies.length,
    copiesActive: copies.filter((a) => a.status === 'active').length,
    ideas: list.reduce((sum, a) => sum + a.metrics.ideas, 0),
    passed: list.reduce((sum, a) => sum + a.metrics.passed, 0),
  }
})
const evolution = computed(() => data.value?.evolution)
const lastRound = computed(() => data.value?.rounds[0] || null)

const opened = ref<string | null>(null)
const toggle = (id: string) => (opened.value = opened.value === id ? null : id)
const components = (agent: OfficeAgent) =>
  (Object.keys(scoreComponents) as ScoreComponent[]).map((key) => ({
    key,
    ...scoreComponents[key],
    value: score100(agent.score?.components[key] ?? null),
  }))
const scoreTitle = (agent: OfficeAgent) =>
  components(agent)
    .map((c) => `${c.label}: ${c.value === null ? 'не считается' : c.value}`)
    .join('\n')
const ideaPrice = (agent: OfficeAgent) =>
  agent.metrics.ideas
    ? rub(Math.round(agent.metrics.costKopecks / agent.metrics.ideas))
    : 'нет идей'
const focus = (agent: OfficeAgent) =>
  agent.parentId
    ? `Копия ${agentShort(nameOf(agent.parentId))}: ${mutationText(agent.mutation)}`
    : (agent.focusLabels ?? agent.params.focusCategories).join(', ')

const generations = computed(() => {
  const groups = new Map<number, OfficeAgent[]>()
  for (const agent of all.value) {
    const list = groups.get(agent.generation) || []
    list.push(agent)
    groups.set(agent.generation, list)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([generation, agents]) => {
      const round = data.value?.rounds.find(
        (r) => r.generation === generation - 1 && r.decision === 'ROTATED',
      )
      return {
        generation,
        agents,
        label:
          generation === 1
            ? `Старт. ${withCount(agents.length, ['разведчик', 'разведчика', 'разведчиков'])}`
            : round
              ? `${day(round.at)}, отбор. ${withCount(round.children.length, ['копия', 'копии', 'копий'])}`
              : 'Новые агенты',
      }
    })
})
const roundSummary = computed(() => {
  const round = lastRound.value
  if (!round) return null
  const fired = round.archived.map((id) => agentShort(nameOf(id)))
  const copied = round.children.map((c) => ({
    parent: agentShort(nameOf(c.parentId)),
    child: agentShort(nameOf(c.id)),
    mutation: mutationText(c.mutation),
  }))
  return { round, fired, copied }
})
const missingText = computed(() => {
  const missing = evolution.value?.missing || []
  if (!missing.length) return []
  const need = missing[0]!.need
  // One line when everyone is short by the same number.
  if (missing.length > 1 && missing.every((m) => m.need === need))
    return [`Каждому не хватает ${withCount(need, ['идеи', 'идей', 'идей'])} до отбора.`]
  return missing.map(
    (m) => `${nameOf(m.agentId)}: не хватает ${withCount(m.need, ['идеи', 'идей', 'идей'])}`,
  )
})
const roundsLine = computed(() => {
  const e = evolution.value
  if (!e || !e.roundsToday) return ''
  return e.roundsToday >= e.roundsPerDay
    ? 'Сегодня отбор уже был. Следующий возможен завтра.'
    : `Сегодня отборов: ${e.roundsToday} из ${e.roundsPerDay}.`
})
const hasDemo = computed(() => !!data.value?.rounds.some((r) => r.isDemo))
const lowData = (agent: OfficeAgent) => agent.status === 'active' && !!agent.score?.lowData
function evolve() {
  void run('evolve', () => officeApi.evolve(), 'Отбор запущен. Результат появится здесь.')
}
</script>
<template>
  <div>
    <div class="page-head">
      <div>
        <h1>Агенты</h1>
        <p>
          Поколение {{ data?.generation ?? 1 }}. Лучшие разведчики получают копию, худшие уходят в
          архив.
          <span v-if="hasDemo" class="badge badge-plain demo-note">Данные демо-провайдера</span>
        </p>
      </div>
      <button
        type="button"
        class="btn"
        :class="evolution?.ready ? 'btn-primary' : ''"
        :disabled="!evolution?.ready || !!busy"
        :title="evolution && !evolution.ready ? evolution.reason : undefined"
        @click="evolve"
      >
        <OfficeIcon name="refresh" />{{ busy ? 'Запускаем' : 'Провести отбор сейчас' }}
      </button>
    </div>

    <OfficeState v-if="!data" :status="status" :pending="pending" :rows="4" @retry="refresh" />
    <template v-else>
      <section class="stat-grid stats" aria-label="Команда в цифрах">
        <div class="stat rise">
          <span class="stat-label">Работают</span><span class="num">{{ stats.active }}</span
          ><span class="stat-note"
            >{{ plural(stats.active, ['разведчик', 'разведчика', 'разведчиков']) }}, плюс
            руководитель и критик</span
          >
        </div>
        <div class="stat rise">
          <span class="stat-label">Уволено</span><span class="num">{{ stats.archived }}</span
          ><span class="stat-note">история и идеи сохранены</span>
        </div>
        <div class="stat rise">
          <span class="stat-label">Копий сделано</span><span class="num">{{ stats.copies }}</span
          ><span class="stat-note">{{ stats.copiesActive }} работают</span>
        </div>
        <div class="stat rise">
          <span class="stat-label">Отбор</span
          ><span class="num">{{ evolution?.ready ? 'Готов' : 'Ждём' }}</span
          ><span class="stat-note">{{
            evolution?.enabled
              ? `нужно ${withCount(evolution.minIdeas, ['идея', 'идеи', 'идей'])} у каждого`
              : 'выключен в настройках'
          }}</span>
        </div>
      </section>

      <section class="card card-pad-lg rise lead-block">
        <div class="lead-card">
          <span class="avatar is-lead big">Р</span>
          <div>
            <h2>Руководитель</h2>
            <p class="muted">
              Раздаёт разведчикам темы, ставит идеям баллы после критика, пишет отчёт. В отборе не
              участвует.
            </p>
          </div>
          <div class="facts">
            <div>
              <b>{{ stats.ideas }}</b
              ><span>идей всего</span>
            </div>
            <div>
              <b>{{ stats.passed }}</b
              ><span>принял критик</span>
            </div>
            <div>
              <b>{{ data.generation }}</b
              ><span>поколение</span>
            </div>
          </div>
        </div>
        <div class="rules">
          <div id="score">
            <b>Балл разведчика</b>Доля принятых идей, качество источников, повторы и цена идеи.
            Когда пойдут продажи, добавятся заказы.
          </div>
          <div>
            <b>Увольнение</b>Худшая половина уходит в архив, когда у каждого набралось
            {{ evolution?.minIdeas ?? 6 }} идей. Идеи остаются в рейтинге.
          </div>
          <div>
            <b>Копия</b>Лучший получает двойника с одним изменением. Копия соревнуется с родителем.
          </div>
        </div>
      </section>

      <div class="duo">
        <section class="card rise" aria-labelledby="last-round">
          <h2 id="last-round">Последний отбор</h2>
          <template v-if="roundSummary">
            <p class="muted small round-when">
              Поколение {{ roundSummary.round.generation }}, {{ day(roundSummary.round.at) }}
            </p>
            <template v-if="roundSummary.round.decision === 'ROTATED'">
              <p v-if="roundSummary.fired.length">
                <span class="badge badge-off">Уволены</span> {{ roundSummary.fired.join(', ') }}
              </p>
              <p v-for="c in roundSummary.copied" :key="c.child" class="copy-line">
                <span class="badge badge-copy">Скопирован</span> {{ c.parent }}. Копия
                {{ c.child }}, {{ c.mutation }}
              </p>
            </template>
            <p v-else><span class="badge badge-wait">Ждём данных</span></p>
            <p class="small muted reason">{{ roundSummary.round.reason }}</p>
          </template>
          <p v-else class="muted">Отбора ещё не было.</p>
        </section>

        <section class="card rise" aria-labelledby="readiness">
          <h2 id="readiness">Готовность к отбору</h2>
          <p v-if="!evolution?.enabled" class="muted">Отбор выключен в настройках.</p>
          <template v-else>
            <p>
              <span class="badge" :class="evolution.ready ? 'badge-ok' : 'badge-wait'">{{
                evolution.ready ? 'Можно проводить' : 'Пока рано'
              }}</span>
              {{ evolution.reason }}
            </p>
            <ul v-if="missingText.length" class="missing">
              <li v-for="line in missingText" :key="line">{{ line }}</li>
            </ul>
            <p v-if="roundsLine" class="small muted">{{ roundsLine }}</p>
          </template>
          <p class="money-line">
            <strong>Отбор по выручке:</strong>
            {{
              evolution?.financial?.decision === 'CLOSED'
                ? evolution.financial.reason
                : 'ждём первых продаж'
            }}
          </p>
        </section>
      </div>

      <section class="card rise" aria-labelledby="scouts">
        <div class="card-head">
          <h2 id="scouts">Разведчики</h2>
          <div class="legend">
            <span class="badge badge-ok">Работает</span><span class="badge badge-copy">Копия</span
            ><span class="badge badge-off">Уволен</span>
          </div>
        </div>
        <div class="table-scroll">
          <table class="table table-stack">
            <thead>
              <tr>
                <th>Агент</th>
                <th>Балл</th>
                <th>Принято критиком</th>
                <th>Цена идеи</th>
                <th>Поколение</th>
                <th>Статус</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="agent in scouts" :key="agent.id">
                <tr :id="`agent-${agent.id}`" :class="{ 'is-off': agent.status === 'archived' }">
                  <td data-full>
                    <div class="agent agent-cell">
                      <span class="avatar" :class="agentAvatar(agent, indexOf(agent))">{{
                        agentShort(agent.name)
                      }}</span>
                      <div>
                        <div class="name">{{ agent.name }}</div>
                        <div class="focus">{{ focus(agent) }}</div>
                      </div>
                    </div>
                  </td>
                  <td data-full>
                    <button
                      type="button"
                      class="score-btn"
                      :title="scoreTitle(agent)"
                      :aria-expanded="opened === agent.id"
                      :aria-label="`Из чего балл ${agent.name}`"
                      @click="toggle(agent.id)"
                    >
                      <OfficeScore
                        :value="score100(agent.score?.total)"
                        :muted="agent.status === 'archived'"
                        :low-data="lowData(agent)"
                      />
                      <OfficeIcon name="chevron" size="sm" class="chev" />
                    </button>
                  </td>
                  <td data-l="Принято критиком">
                    {{ agent.metrics.passed }} из {{ agent.metrics.ideas }}
                  </td>
                  <td data-l="Цена идеи" class="mono">{{ ideaPrice(agent) }}</td>
                  <td data-l="Поколение">{{ agent.generation }}</td>
                  <td>
                    <span v-if="agent.retired" class="badge badge-off"
                      >Уволен {{ day(agent.retired.at) }}</span
                    >
                    <OfficeBadge v-else :badge="agentBadge(agent)" />
                  </td>
                </tr>
                <tr v-if="opened === agent.id" class="breakdown">
                  <td colspan="6" data-full>
                    <div class="parts">
                      <div v-for="c in components(agent)" :key="c.key" :title="c.hint">
                        <span class="small muted">{{ c.label }}</span>
                        <strong v-if="c.value !== null" class="num">{{ c.value }}</strong>
                        <span v-else class="small muted">не считается</span>
                      </div>
                    </div>
                    <p v-if="agent.retired" class="small muted">{{ agent.retired.reason }}</p>
                    <p class="small muted">
                      Повторов: {{ agent.metrics.duplicates }}. Продуктов прошло проверку:
                      {{ agent.metrics.builtPassed }}. Заказов выдано:
                      {{ agent.metrics.delivered }}.
                    </p>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </section>

      <section class="card rise gens" aria-labelledby="generations">
        <div class="card-head">
          <h2 id="generations">Поколения</h2>
          <span class="muted small">Кто от кого, кто ушёл</span>
        </div>
        <div v-for="g in generations" :key="g.generation" class="gen">
          <div class="gen-label">
            <strong>{{ g.generation }}</strong
            ><span>{{ g.label }}</span>
          </div>
          <div class="gen-row">
            <div
              v-for="agent in g.agents"
              :key="agent.id"
              class="gen-card"
              :class="{
                'is-off': agent.status === 'archived',
                'is-copy': agent.parentId && agent.status === 'active',
              }"
            >
              <div class="head">
                <span class="avatar" :class="agentAvatar(agent, indexOf(agent))">{{
                  agentShort(agent.name)
                }}</span
                ><b>{{ agentShort(agent.name) }}</b
                ><span
                  v-if="agent.score"
                  class="num"
                  :class="{ muted: agent.status === 'archived' }"
                  >{{ score100(agent.score.total) }}</span
                ><span v-else class="fresh">новый</span>
              </div>
              <span v-if="agent.parentId" class="parent"
                >Копия <b>{{ agentShort(nameOf(agent.parentId)) }}</b
                >, {{ mutationText(agent.mutation) }}</span
              >
              <span class="why">{{
                agent.retired
                  ? `Уволен ${day(agent.retired.at)}: ${agent.metrics.passed} из ${agent.metrics.ideas} идей`
                  : `${agent.metrics.passed} из ${agent.metrics.ideas} идей приняты`
              }}</span>
            </div>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
<style scoped>
.demo-note {
  margin-left: 6px;
  vertical-align: 1px;
}
#score,
tr[id^='agent-'] {
  scroll-margin-top: 80px;
}
.stats {
  margin-bottom: var(--s-5);
}
.lead-block {
  margin-bottom: var(--s-5);
}
.lead-card {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: var(--s-5);
  align-items: center;
}
.avatar.big {
  width: 60px;
  height: 60px;
  font-size: 24px;
}
.lead-card p {
  margin-top: 4px;
}
.facts {
  display: flex;
  gap: var(--s-6);
}
.facts b {
  display: block;
  font: 800 var(--text-xl) / 1 var(--font-display);
}
.facts span {
  font-size: var(--text-sm);
  color: var(--muted);
}
.rules {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--s-3);
  margin-top: var(--s-5);
}
.rules div {
  background: var(--surface-2);
  border-radius: var(--r-md);
  padding: var(--s-3) var(--s-4);
  font-size: var(--text-sm);
}
.rules b {
  display: block;
  margin-bottom: 2px;
}
.duo {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--s-5);
  margin-bottom: var(--s-5);
}
.duo h2 {
  margin-bottom: var(--s-3);
}
.duo p + p {
  margin-top: var(--s-2);
}
.round-when {
  margin-bottom: var(--s-3);
}
.reason {
  margin-top: var(--s-3);
}
.missing {
  margin: var(--s-2) 0;
  padding-left: 18px;
  line-height: 1.7;
}
.money-line {
  margin-top: var(--s-4);
  padding-top: var(--s-3);
  border-top: 1px solid var(--line);
  font-size: var(--text-sm);
}
.legend {
  display: flex;
  gap: var(--s-2);
  flex-wrap: wrap;
}
.table-scroll {
  overflow-x: auto;
}
.agent-cell {
  grid-template-columns: 44px 1fr;
}
.table .name {
  font-weight: 600;
}
.table .focus {
  font-size: var(--text-sm);
  color: var(--muted);
}
.table tr.is-off td {
  color: var(--muted);
}
.table tr.is-off .name {
  text-decoration: line-through;
}
.score-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 0;
  background: none;
  padding: 4px;
  margin: -4px;
  border-radius: var(--r-sm);
  cursor: pointer;
  font: inherit;
  color: inherit;
}
.score-btn:hover {
  background: var(--surface-2);
}
.score-btn .score {
  min-width: 130px;
}
.score-btn[aria-expanded='true'] .chev {
  transform: rotate(180deg);
}
.chev {
  color: var(--muted);
  transition: transform var(--dur) var(--ease);
}
.breakdown td {
  background: var(--surface-2);
}
.parts {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: var(--s-3);
  margin-bottom: var(--s-2);
}
.parts div {
  display: grid;
  gap: 2px;
}
.parts .num {
  font-size: var(--text-lg);
}
.gen {
  grid-template-columns: 170px 1fr;
}
.gen-card .head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.gen-card .head .avatar {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  font-size: 13px;
}
.gen-card .head .num {
  margin-left: auto;
  font-size: 20px;
}
.gen-card .fresh {
  margin-left: auto;
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--muted);
}
.gen-card .why {
  font-size: var(--text-xs);
  color: var(--muted);
}
@media (max-width: 1023px) {
  .lead-card {
    grid-template-columns: auto 1fr;
  }
  .facts {
    grid-column: 1 / -1;
  }
  .rules,
  .duo {
    grid-template-columns: 1fr;
  }
  .parts {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .gen {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 639px) {
  .parts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .breakdown {
    display: block !important;
  }
}
</style>
