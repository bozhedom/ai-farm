<script setup lang="ts">
import {
  useOfficeAgents,
  useOfficeMoney,
  useOfficeOverview,
  useOfficeSettings,
} from '~/composables/office/data'
import {
  ago,
  count,
  day,
  isToday,
  percent,
  rub,
  splitSentence,
  todayTitle,
  upcoming,
  withCount,
} from '~/composables/office/format'
import {
  agentAvatar,
  agentBadge,
  agentShort,
  modeBadge,
  score100,
} from '~/composables/office/labels'

useHead({ title: 'Главная' })
const { data: o, status, pending, refresh } = useOfficeOverview()
const { data: agents } = useOfficeAgents(10000)
const { data: money } = useOfficeMoney(10000)
const { data: settings } = useOfficeSettings(30000)

const clock = ref(new Date())
let tick: ReturnType<typeof setInterval> | undefined
onMounted(() => (tick = setInterval(() => (clock.value = new Date()), 30000)))
onBeforeUnmount(() => tick && clearInterval(tick))

const activeScouts = computed(() => agents.value?.agents.filter((a) => a.status === 'active') || [])

const now = computed(() => {
  const v = o.value
  if (!v) return null
  if (v.mode === 'emergency_stop')
    return {
      title: 'Ферма остановлена',
      detail: 'Новые задачи не берём. Нажмите «Продолжить», когда будете готовы.',
      live: false,
    }
  if (!v.worker.alive) return { title: 'Сервер не отвечает', detail: v.worker.reason, live: false }
  if (v.mode === 'paused')
    return {
      title: 'Ферма на паузе',
      detail: 'Начатые заказы доделываем, новые поиски ждут.',
      live: false,
    }
  if (v.now)
    return {
      title: v.now.title,
      detail: `${v.now.detail} Шаг ${v.now.step} из ${v.now.steps}.`,
      live: true,
    }
  const latest = v.feed[0]
  const fresh = latest && clock.value.getTime() - new Date(latest.at).getTime() < 15 * 60000
  if (fresh)
    return {
      title: splitSentence(latest.text).main,
      detail: `${ago(latest.at, clock.value).replace(/^./, (c) => c.toUpperCase())}. ${todayLine.value}`,
      live: true,
    }
  return {
    title: v.worker.nextAt
      ? `Ждём следующего запуска ${upcoming(v.worker.nextAt, clock.value)}`
      : 'Ферма ждёт задач',
    detail: v.worker.reason,
    live: true,
  }
})

const todayLine = computed(() => {
  const t = o.value?.today
  if (!t || !t.ideas) return 'Сегодня новых идей пока нет.'
  return `Сегодня ${withCount(t.ideas, ['идея', 'идеи', 'идей'])}, критик принял ${t.ideasAccepted}.`
})

const scouting = computed(() => {
  const perAgent = settings.value?.scoutsPerStrategyPerDay
  if (!o.value || !perAgent || !activeScouts.value.length) return null
  const planned = perAgent * activeScouts.value.length
  const done = Math.min(o.value.today.ideas, planned)
  return { planned, done, width: `${percent(done, planned)}%` }
})

const lastRound = computed(() => agents.value?.rounds[0] || null)
const lastRoundText = computed(() => {
  const round = lastRound.value
  if (!round) return 'Ещё не было'
  return round.decision === 'ROTATED'
    ? `${day(round.at)}, ${withCount(round.archived.length, ['уволен', 'уволено', 'уволено'])}`
    : `${day(round.at)}, ждём данных`
})

const team = computed(() => {
  const list = agents.value?.agents || []
  const active = list
    .filter((a) => a.status === 'active')
    .sort((a, b) => (b.score?.total ?? -1) - (a.score?.total ?? -1))
  const retired = list
    .filter((a) => a.status === 'archived' && a.retired)
    .sort((a, b) => (b.retired!.at > a.retired!.at ? 1 : -1))
    .slice(0, 1)
  return [...active, ...retired].map((agent) => ({
    agent,
    short: agentShort(agent.name),
    avatar: agentAvatar(agent, list.indexOf(agent)),
    badge: agentBadge(agent),
    score: score100(agent.score?.total),
    lowData: agent.status === 'active' && !!agent.score?.lowData,
  }))
})

const todayFeed = computed(() => (o.value?.feed || []).filter((item) => isToday(item.at)))
const feedItems = computed(() =>
  todayFeed.value.length ? todayFeed.value : (o.value?.feed || []).slice(0, 8),
)
const isFresh = computed(() => !!o.value && o.value.totals.ideas === 0 && o.value.feed.length === 0)
const subtitle = computed(() => {
  const v = o.value
  if (!v) return todayTitle(clock.value) + '.'
  return `${todayTitle(clock.value)}. ${v.worker.reason}`
})
</script>
<template>
  <div>
    <div class="page-head">
      <div>
        <h1>Главная</h1>
        <p>{{ subtitle }}</p>
      </div>
      <div class="row head-actions">
        <OfficeModeControls :mode="o?.mode" />
        <OfficeFindIdeas :mode="o?.mode" />
      </div>
    </div>

    <OfficeState v-if="!o" :status="status" :pending="pending" :rows="4" @retry="refresh" />
    <template v-else>
      <section class="card card-ink card-pad-lg rise now-card" aria-label="Сейчас">
        <div class="now">
          <div>
            <span class="live now-live" :class="{ 'is-still': !now?.live }"
              ><i class="live-dot" :class="{ 'is-wait': !now?.live }" />Сейчас.
              {{ modeBadge[o.mode].label }}</span
            >
            <h2>{{ now?.title }}</h2>
            <p class="muted now-detail">{{ now?.detail }}</p>
            <div v-if="scouting" class="now-progress">
              <div class="bar bar-lg" :class="{ 'is-live': now?.live }">
                <i :style="{ width: scouting.width }" />
              </div>
              <span class="small muted"
                >Разведок сегодня: {{ scouting.done }} из {{ scouting.planned }}</span
              >
            </div>
            <div class="now-actions">
              <NuxtLink class="btn btn-sm" to="/office/ideas">Идеи</NuxtLink>
              <NuxtLink class="btn btn-sm" to="/office/settings#journal">Техжурнал</NuxtLink>
            </div>
          </div>
          <dl class="now-side">
            <div>
              <dt>Следующий запуск</dt>
              <dd>{{ o.worker.nextAt ? upcoming(o.worker.nextAt, clock) : 'Не назначен' }}</dd>
            </div>
            <div>
              <dt>Расходы сегодня</dt>
              <dd>
                {{ rub(money?.daySpentKopecks ?? o.today.spentKopecks) }}
                <template v-if="money">из {{ rub(money.limits.dailyKopecks) }}</template>
              </dd>
            </div>
            <div v-if="settings">
              <dt>Модель</dt>
              <dd>{{ settings.providers.model }}</dd>
            </div>
            <div>
              <dt>Последний отбор</dt>
              <dd>{{ agents ? lastRoundText : 'Загружаем' }}</dd>
            </div>
          </dl>
        </div>
      </section>

      <section class="stat-grid home-stats" aria-label="Ключевые цифры">
        <div class="stat rise">
          <span class="stat-label">Идей найдено</span
          ><span class="num">{{ count(o.totals.ideas) }}</span
          ><span class="stat-note"
            ><span v-if="o.today.ideas" class="delta">+{{ o.today.ideas }} сегодня</span
            ><template v-else>сегодня пока нет</template></span
          >
        </div>
        <div class="stat rise">
          <span class="stat-label">В продаже</span
          ><span class="num">{{ count(o.totals.publicProducts) }}</span
          ><span class="stat-note"
            ><span v-if="o.today.productsPublished" class="delta"
              >+{{ o.today.productsPublished }} сегодня</span
            ><template v-else
              >из
              {{ withCount(o.totals.products, ['продукта', 'продуктов', 'продуктов']) }}</template
            ></span
          >
        </div>
        <div class="stat rise">
          <span class="stat-label">Заказов</span
          ><span class="num">{{ count(o.totals.orders) }}</span
          ><span class="stat-note"
            ><span v-if="o.today.ordersDelivered" class="delta"
              >{{ o.today.ordersDelivered }} готово сегодня</span
            ><template v-else>сегодня готовых нет</template></span
          >
        </div>
        <div class="stat rise">
          <span class="stat-label">{{ money ? 'Расходы за месяц' : 'Расходы сегодня' }}</span
          ><span class="num">{{ rub(money ? money.monthSpentKopecks : o.today.spentKopecks) }}</span
          ><span class="stat-note">{{
            money ? `модели и поиск, лимит ${rub(money.limits.monthlyKopecks)}` : 'модели и поиск'
          }}</span>
        </div>
        <div class="stat rise is-money">
          <span class="stat-label">Реальная выручка</span
          ><span class="num">{{ rub(o.totals.realRevenueKopecks) }}</span
          ><span class="stat-note">{{
            o.totals.realRevenueKopecks ? 'настоящие оплаты' : 'продаж за деньги пока нет'
          }}</span>
        </div>
        <div class="stat rise is-test">
          <span class="stat-label">Тестовые платежи</span
          ><span class="num">{{
            money ? rub(money.testPayments.kopecks) : count(o.totals.testPayments)
          }}</span
          ><span class="stat-note"><span class="badge badge-test">Не выручка</span></span>
        </div>
      </section>

      <section v-if="isFresh" class="card start rise" aria-label="С чего начать">
        <h2>С чего начать</h2>
        <div class="how">
          <article>
            <h3>Найдите идеи</h3>
            <p>Нажмите «Найти идеи сейчас». Разведчики поищут, на чём можно заработать.</p>
          </article>
          <article>
            <h3>Критик отберёт лучшие</h3>
            <p>Слабые идеи отсеются. То, что ферма умеет сама, станет продуктом на сайте.</p>
          </article>
          <article>
            <h3>Следите за результатом</h3>
            <p>Заказы, найденные клиенты и расходы появятся здесь.</p>
          </article>
        </div>
      </section>

      <div class="two">
        <section class="card rise" aria-labelledby="feed-title">
          <div class="card-head">
            <h2 id="feed-title">
              {{ todayFeed.length ? 'Что произошло сегодня' : 'Последние события' }}
            </h2>
            <NuxtLink class="btn btn-ghost btn-sm" to="/office/settings#journal"
              >Весь журнал</NuxtLink
            >
          </div>
          <OfficeFeed v-if="feedItems.length" :items="feedItems" :limit="10" />
          <p v-else class="muted">Пока тихо. События появятся после первого поиска.</p>
        </section>

        <div class="stack side-col">
          <section class="card rise" aria-labelledby="team-title">
            <div class="card-head">
              <h2 id="team-title">Команда</h2>
              <NuxtLink class="btn btn-ghost btn-sm" to="/office/agents">Все агенты</NuxtLink>
            </div>
            <div class="team-list">
              <div class="agent">
                <span class="avatar is-lead">Р</span>
                <div>
                  <div class="name">Руководитель</div>
                  <div class="focus">Раздаёт задания, ставит баллы, пишет отчёт</div>
                </div>
                <OfficeBadge :badge="modeBadge[o.mode]" />
              </div>
              <div
                v-for="row in team"
                :key="row.agent.id"
                class="agent"
                :class="{ 'is-off': row.agent.status === 'archived' }"
              >
                <span class="avatar" :class="row.avatar">{{ row.short }}</span>
                <div>
                  <div class="name">
                    {{ row.agent.name }}
                    <span class="muted xs">пок. {{ row.agent.generation }}</span>
                  </div>
                  <OfficeScore
                    :value="row.score"
                    :muted="row.agent.status === 'archived'"
                    :low-data="row.lowData"
                  />
                </div>
                <OfficeBadge :badge="row.badge" />
              </div>
              <p v-if="!agents" class="muted small">Загружаем команду</p>
            </div>
            <div v-if="agents" class="card-foot">
              <span class="small muted">{{
                agents.evolution.ready ? 'Можно провести отбор' : agents.evolution.reason
              }}</span>
              <NuxtLink class="small" to="/office/agents#score">Как считается балл</NuxtLink>
            </div>
          </section>

          <section class="card card-tint-sun rise waiting" aria-labelledby="waiting-title">
            <h3 id="waiting-title">Ждут вас</h3>
            <ul v-if="o.needsOwner.length">
              <li v-for="(item, i) in o.needsOwner" :key="i">
                <NuxtLink :to="item.link">{{ item.text }}</NuxtLink>
              </li>
            </ul>
            <p v-else class="small">Ничего не ждёт. Ферма справляется сама.</p>
          </section>
        </div>
      </div>
    </template>
  </div>
</template>
<style scoped>
.head-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
}
.now {
  display: grid;
  grid-template-columns: 1fr 300px;
  gap: var(--s-8);
  align-items: start;
}
.now h2 {
  font-size: var(--text-2xl);
  margin-top: var(--s-2);
  max-width: 30ch;
  overflow-wrap: anywhere;
}
.now-live {
  color: #9fe3bf;
}
.now-live.is-still {
  color: #f3d58a;
}
.now-detail {
  margin-top: var(--s-2);
}
.now-progress {
  margin-top: var(--s-5);
  max-width: 520px;
  display: grid;
  gap: 8px;
}
.now-side {
  display: grid;
  gap: var(--s-3);
  margin: 0;
  border-left: 1px solid rgba(255, 255, 255, 0.14);
  padding-left: var(--s-6);
}
.now-side dt {
  font-size: var(--text-sm);
  color: #b7bac3;
}
.now-side dd {
  margin: 0;
  font: 700 var(--text-lg) / 1.25 var(--font-display);
  color: #fff;
}
.now-actions {
  display: flex;
  gap: var(--s-2);
  margin-top: var(--s-5);
}
.card-ink .btn {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.18);
  color: #fff;
}
.card-ink .btn:hover {
  background: rgba(255, 255, 255, 0.16);
}
.card-ink .bar {
  background: rgba(255, 255, 255, 0.14);
}
.card-ink .bar > i {
  background: var(--sun);
}
.home-stats {
  margin-top: var(--s-5);
}
@media (min-width: 1280px) {
  .home-stats {
    grid-template-columns: repeat(6, 1fr);
  }
}
@media (min-width: 1024px) and (max-width: 1279px) {
  .home-stats {
    grid-template-columns: repeat(3, 1fr);
  }
}
.start {
  margin-top: var(--s-5);
}
.start h2 {
  margin-bottom: var(--s-4);
}
.two {
  display: grid;
  grid-template-columns: 1.4fr 1fr;
  gap: var(--s-5);
  margin-top: var(--s-5);
  align-items: start;
}
.team-list {
  display: grid;
  gap: 14px;
}
.team-list .agent .score {
  min-width: 0;
  width: 100%;
}
.team-list .name {
  font-weight: 600;
}
.team-list .focus {
  font-size: var(--text-xs);
  color: var(--muted);
}
.waiting ul {
  margin: 8px 0 0;
  padding-left: 18px;
  line-height: 1.7;
}
.waiting p {
  margin-top: 6px;
}
@media (max-width: 1023px) {
  .now {
    grid-template-columns: 1fr;
    gap: var(--s-5);
  }
  .now-side {
    border-left: 0;
    padding-left: 0;
    border-top: 1px solid rgba(255, 255, 255, 0.14);
    padding-top: var(--s-4);
    grid-template-columns: 1fr 1fr;
  }
  .two {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 639px) {
  .head-actions {
    justify-content: flex-start;
  }
  .now h2 {
    font-size: var(--text-xl);
  }
}
</style>
