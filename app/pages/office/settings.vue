<script setup lang="ts">
import type { OfficeMode, OfficeSettingsUpdate } from '../../../core/contracts/office'
import { officeApi, useOfficeAction } from '~/composables/office/actions'
import {
  useAutoProposals,
  useJournal,
  useOfficeOverview,
  useOfficeSettings,
  useReadiness,
} from '~/composables/office/data'
import { rub, upcoming, when } from '~/composables/office/format'
import { modeBadge } from '~/composables/office/labels'

useHead({ title: 'Настройки' })
const { data: s, status, pending, refresh } = useOfficeSettings(10000)
const { data: overview } = useOfficeOverview()
const { data: health } = useReadiness()
const journalOpen = ref(false)
const { data: journal, status: journalStatus } = useJournal(journalOpen)
const { busy, run } = useOfficeAction()
const auto = useAutoProposals()

const mode = computed<OfficeMode | undefined>(
  () => overview.value?.mode || (s.value?.mode as OfficeMode | undefined),
)

type Form = Required<Omit<OfficeSettingsUpdate, 'scheduleHourUtc'>>
const form = reactive<Form>({
  evolutionEnabled: true,
  evolutionMinIdeas: 6,
  evolutionRoundsPerDay: 1,
  scoutsPerStrategyPerDay: 1,
  leadsPerDay: 3,
})
const dirty = ref(false)
watch(
  s,
  (value) => {
    if (!value || dirty.value) return
    form.evolutionEnabled = value.evolutionEnabled
    form.evolutionMinIdeas = value.evolutionMinIdeas
    form.evolutionRoundsPerDay = value.evolutionRoundsPerDay
    form.scoutsPerStrategyPerDay = value.scoutsPerStrategyPerDay
    form.leadsPerDay = value.leadsPerDay
  },
  { immediate: true },
)
const fields: {
  key: Exclude<keyof Form, 'evolutionEnabled'>
  label: string
  hint: string
  min: number
  max: number
}[] = [
  {
    key: 'evolutionMinIdeas',
    label: 'Минимум идей для отбора',
    hint: 'у каждого разведчика',
    min: 2,
    max: 50,
  },
  {
    key: 'evolutionRoundsPerDay',
    label: 'Отборов в день',
    hint: 'сколько раз в день можно проводить отбор',
    min: 1,
    max: 10,
  },
  {
    key: 'scoutsPerStrategyPerDay',
    label: 'Разведок на агента в день',
    hint: 'больше разведок, больше расходов',
    min: 1,
    max: 10,
  },
  {
    key: 'leadsPerDay',
    label: 'Поисков клиентов в день',
    hint: 'по продуктам на сайте',
    min: 0,
    max: 20,
  },
]
async function save() {
  const update: OfficeSettingsUpdate = {
    evolutionEnabled: form.evolutionEnabled,
    evolutionMinIdeas: Number(form.evolutionMinIdeas),
    evolutionRoundsPerDay: Number(form.evolutionRoundsPerDay),
    scoutsPerStrategyPerDay: Number(form.scoutsPerStrategyPerDay),
    leadsPerDay: Number(form.leadsPerDay),
  }
  const done = await run(
    'save',
    () => officeApi.saveSettings(update),
    'Сохранено. Сработает при следующем запуске.',
  )
  if (done !== undefined) dirty.value = false
}
function toggleSchedule() {
  if (!s.value) return
  const next = !s.value.scheduleEnabled
  void run(
    'schedule',
    () => officeApi.setSchedule(next),
    next ? 'Расписание включено.' : 'Расписание выключено. Запускайте поиск вручную.',
  )
}
function restartResearch() {
  void run(
    'research-season',
    () => officeApi.restartResearch(),
    'Новый сезон открыт: разведка и сборка услуг продолжатся по расписанию.',
  )
}
// The hour is stored in UTC; the owner picks it in the browser's local time.
const hourOptions = computed(() => {
  const base = new Date()
  return Array.from({ length: 21 }, (_, utc) => {
    const at = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), utc))
    return {
      utc,
      local: at.getHours(),
      label: `${String(at.getHours()).padStart(2, '0')}:00`,
    }
  }).sort((a, b) => a.local - b.local)
})
const zoneName = computed(() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  } catch {
    return ''
  }
})
function setHour(event: Event) {
  const value = Number((event.target as HTMLSelectElement).value)
  if (!Number.isInteger(value)) return
  void run(
    'hour',
    () => officeApi.saveSettings({ scheduleHourUtc: value }),
    'Час запуска сохранён.',
  )
}
function setScope(event: Event) {
  const value = (event.target as HTMLSelectElement).value as 'rotate' | 'all'
  void run(
    'scope',
    () => officeApi.setResearchScope(value),
    'Сохранено. Сработает при следующем запуске.',
  )
}

const checks = computed(() => {
  const c = health.value?.checks || {}
  return [
    { key: 'database', label: 'База данных' },
    { key: 'worker', label: 'Сервер заданий' },
    { key: 'payments', label: 'Проверка оплат' },
    { key: 'model', label: 'Модель' },
    { key: 'search', label: 'Поиск' },
    { key: 'backup', label: 'Резервная копия за сутки' },
  ].map((item) => ({ ...item, ok: c[item.key] === true }))
})
const jobLabels: Record<string, string> = {
  scout: 'Разведка',
  research: 'Сборка продукта',
  fulfill: 'Заказ',
  report: 'Отчёт',
  lead: 'Поиск клиентов',
  evolve: 'Отбор',
  evaluate: 'Оценка продаж',
}
const jobStatus: Record<string, string> = {
  queued: 'В очереди',
  running: 'Идёт',
  done: 'Готово',
  failed: 'Сбой',
  cancelled: 'Отменено',
}
onMounted(() => {
  if (location.hash === '#journal') journalOpen.value = true
})
</script>
<template>
  <div>
    <div class="page-head">
      <div>
        <h1>Настройки</h1>
        <p>Режим, расписание, отбор и лимиты.</p>
      </div>
    </div>

    <OfficeState v-if="!s" :status="status" :pending="pending" @retry="refresh" />
    <div v-else class="grid">
      <section class="card rise" aria-labelledby="mode-title">
        <div class="card-head">
          <h2 id="mode-title">Режим</h2>
          <OfficeBadge v-if="mode" :badge="modeBadge[mode]" />
        </div>
        <OfficeModeControls :mode="mode" stop-label="Остановить всё" />
        <p class="small muted mode-hint">
          {{
            mode === 'running'
              ? 'Пауза: новые поиски ждут, начатые заказы доделываем. Остановить всё: к модели больше не обращаемся.'
              : 'Продолжить: ферма снова работает по расписанию.'
          }}
        </p>
      </section>

      <section class="card rise" aria-labelledby="schedule-title">
        <h2 id="schedule-title">Расписание</h2>
        <div v-if="s.researchEnabled === false" class="season" role="status">
          <p class="small">
            <strong>Сезон исследований закрыт.</strong> За 28 дней не было настоящих продаж, чтобы
            выбрать лучших разведчиков, поэтому разведка идей и сборка услуг остановлены. Откройте
            новый сезон, чтобы они продолжились; принятые заказы и история сохраняются.
          </p>
          <button
            type="button"
            class="btn btn-primary btn-sm"
            :disabled="!!busy"
            @click="restartResearch"
          >
            Начать новый сезон
          </button>
        </div>
        <div class="switch-row">
          <div>
            <strong>Поиск по расписанию</strong>
            <p class="small muted">
              {{
                s.scheduleEnabled && overview?.worker.nextAt
                  ? `Следующий запуск ${upcoming(overview.worker.nextAt)}`
                  : s.scheduleEnabled
                    ? 'Руководитель запускает поиск каждый день'
                    : 'Выключено, запускайте поиск вручную'
              }}
            </p>
          </div>
          <button
            type="button"
            class="switch"
            role="switch"
            :aria-checked="s.scheduleEnabled"
            aria-label="Поиск по расписанию"
            :disabled="!!busy"
            @click="toggleSchedule"
          />
        </div>
        <div class="field">
          <label for="hour">Час ежедневного запуска</label>
          <select
            id="hour"
            class="select"
            :value="s.scheduleHourUtc ?? 0"
            :disabled="!!busy"
            @change="setHour"
          >
            <option v-for="h in hourOptions" :key="h.utc" :value="h.utc">{{ h.label }}</option>
          </select>
          <span class="hint">По вашему времени{{ zoneName ? ` (${zoneName})` : '' }}</span>
        </div>
        <div class="field">
          <label for="scope">Сборка продуктов</label>
          <select
            id="scope"
            class="select"
            :value="s.researchScope"
            :disabled="!!busy"
            @change="setScope"
          >
            <option value="rotate">Один тип услуги в день, по очереди</option>
            <option value="all">Все типы услуг подряд</option>
          </select>
        </div>
      </section>

      <section class="card rise wide" aria-labelledby="evolution-title">
        <h2 id="evolution-title">Отбор и нагрузка</h2>
        <form class="evo" @submit.prevent="save">
          <div class="switch-row">
            <div>
              <strong>Отбор разведчиков</strong>
              <p class="small muted">Худшие уходят в архив, лучшие получают копию</p>
            </div>
            <button
              type="button"
              class="switch"
              role="switch"
              :aria-checked="form.evolutionEnabled"
              aria-label="Отбор разведчиков"
              @click="((form.evolutionEnabled = !form.evolutionEnabled), (dirty = true))"
            />
          </div>
          <div class="fields">
            <div v-for="f in fields" :key="f.key" class="field">
              <label :for="f.key">{{ f.label }}</label>
              <input
                :id="f.key"
                v-model.number="form[f.key]"
                class="input"
                type="number"
                inputmode="numeric"
                :min="f.min"
                :max="f.max"
                required
                @input="dirty = true"
              />
              <span class="hint">{{ f.hint }}</span>
            </div>
          </div>
          <div class="row">
            <button class="btn btn-primary" :disabled="!!busy || !dirty">
              {{ busy === 'save' ? 'Сохраняем' : 'Сохранить' }}
            </button>
            <button
              v-if="dirty"
              type="button"
              class="btn btn-ghost"
              @click="((dirty = false), refresh())"
            >
              Отменить
            </button>
          </div>
        </form>
      </section>

      <section id="limits" class="card rise" aria-labelledby="limits-title">
        <h2 id="limits-title">Лимиты расходов</h2>
        <dl class="lines">
          <div>
            <dt>В день</dt>
            <dd class="num">{{ rub(s.limits.dailyKopecks) }}</dd>
          </div>
          <div>
            <dt>В месяц</dt>
            <dd class="num">{{ rub(s.limits.monthlyKopecks) }}</dd>
          </div>
        </dl>
        <p class="small muted">Лимиты расходов настраивает администратор.</p>
      </section>

      <section class="card rise" aria-labelledby="providers-title">
        <h2 id="providers-title">Подключения</h2>
        <dl class="lines">
          <div>
            <dt>Модель</dt>
            <dd>
              {{ s.providers.model }}
              <span v-if="s.modelId" class="model-id xs muted">{{ s.modelId }}</span>
            </dd>
          </div>
          <div>
            <dt>Поиск</dt>
            <dd>{{ s.providers.search }}</dd>
          </div>
          <div>
            <dt>Оплата</dt>
            <dd>{{ s.providers.payment }}</dd>
          </div>
        </dl>
      </section>

      <section class="card rise" aria-labelledby="health-title">
        <div class="card-head">
          <h2 id="health-title">Состояние сервера</h2>
          <span
            v-if="health"
            class="badge"
            :class="health.status === 'ok' ? 'badge-ok' : 'badge-wait'"
            >{{ health.status === 'ok' ? 'Всё в порядке' : 'Есть замечания' }}</span
          >
        </div>
        <ul v-if="health" class="checks">
          <li v-for="c in checks" :key="c.key">
            <i class="live-dot" :class="c.ok ? '' : 'is-wait'" />
            <span>{{ c.label }}</span>
            <span class="small" :class="c.ok ? 'ok' : 'warn'">{{
              c.ok ? 'работает' : 'нет ответа'
            }}</span>
          </li>
        </ul>
        <p v-else class="muted small">Проверяем</p>
        <p v-if="health" class="xs muted">Проверено {{ when(health.checkedAt) }}</p>
      </section>

      <section class="card card-flat rise" aria-labelledby="limits-rules">
        <h2 id="limits-rules">Чего ферма не делает</h2>
        <ul class="plain-list">
          <li>Не трогает деньги, сервер и аккаунты.</li>
          <li v-if="auto?.on">
            Не пишет клиентам с сайта и по почте: им отвечаете вы. На площадках, где вы вошли ({{
              auto.platforms.join(', ')
            }}), ИИ откликается сам в пределах дневного лимита.
          </li>
          <li v-else>Никому не пишет: отклики отправляете вы.</li>
          <li>Не принимает настоящие платежи: оплата тестовая.</li>
          <li>Не запускает идеи, где нужны люди. Для них готовит план.</li>
        </ul>
      </section>

      <section id="journal" class="card rise wide" aria-labelledby="journal-title">
        <details
          :open="journalOpen"
          @toggle="journalOpen = ($event.target as HTMLDetailsElement).open"
        >
          <summary>
            <h2 id="journal-title">Техжурнал</h2>
            <span class="small muted">Задания и решения сервера</span>
          </summary>
          <p v-if="journalOpen && !journal" class="small muted">
            {{ journalStatus.error || 'Загружаем' }}
          </p>
          <div v-if="journal" class="journal">
            <div>
              <h3>Задания</h3>
              <ul class="tech-list">
                <li v-for="job in journal.jobs" :key="job.id">
                  <span>{{ jobLabels[job.kind] || job.kind }}</span>
                  <span class="badge badge-plain">{{ jobStatus[job.status] || job.status }}</span>
                  <span v-if="job.count > 1" class="badge badge-plain" title="Подряд одинаковых"
                    >×{{ job.count }}</span
                  >
                  <span class="xs muted"
                    >попытка {{ job.attempts }}, {{ when(job.created_at) }}</span
                  >
                  <code v-if="job.error_code" class="xs">{{ job.error_code }}</code>
                </li>
              </ul>
            </div>
            <div>
              <h3>Решения</h3>
              <ul class="tech-list">
                <li v-for="event in journal.audit" :key="event.id">
                  <span class="xs muted mono"
                    >{{ event.count > 1 ? `${when(event.first_at)} – ` : ''
                    }}{{ when(event.created_at) }}</span
                  >
                  <span
                    >{{ event.message }}
                    <span v-if="event.count > 1" class="badge badge-plain" title="Подряд одинаковых"
                      >×{{ event.count }}</span
                    ></span
                  >
                </li>
              </ul>
            </div>
          </div>
        </details>
      </section>
    </div>
  </div>
</template>
<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--s-5);
  align-items: start;
}
.wide {
  grid-column: 1 / -1;
}
.card h2 {
  margin-bottom: var(--s-3);
}
.card-head h2 {
  margin-bottom: 0;
}
.plain-list {
  margin: 0;
  padding-left: 18px;
  line-height: 1.7;
}
.model-id {
  display: block;
  font-weight: 400;
  overflow-wrap: anywhere;
}
.mode-hint {
  margin-top: var(--s-3);
}
.field + .field {
  margin-top: var(--s-3);
}
.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-4);
  padding: var(--s-2) 0 var(--s-4);
}
.switch-row p {
  margin-top: 2px;
}
.fields {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--s-4);
  margin-bottom: var(--s-4);
}
.lines {
  margin: 0 0 var(--s-3);
  display: grid;
  gap: var(--s-3);
}
.lines div {
  display: flex;
  justify-content: space-between;
  gap: var(--s-3);
  padding-bottom: var(--s-3);
  border-bottom: 1px solid var(--line);
}
.lines dt {
  color: var(--muted);
}
.lines dd {
  margin: 0;
  text-align: right;
  font-weight: 600;
}
.checks {
  list-style: none;
  margin: 0 0 var(--s-3);
  padding: 0;
  display: grid;
  gap: 10px;
}
.checks li {
  display: grid;
  grid-template-columns: 14px 1fr auto;
  gap: 10px;
  align-items: center;
}
.checks .ok {
  color: var(--st-ok-ink);
}
.checks .warn {
  color: var(--st-wait-ink);
}
details summary {
  cursor: pointer;
  display: flex;
  align-items: baseline;
  gap: var(--s-3);
  flex-wrap: wrap;
  list-style: none;
}
details summary::-webkit-details-marker {
  display: none;
}
details summary h2 {
  margin: 0;
}
details summary::after {
  content: 'Показать';
  margin-left: auto;
  color: var(--brand);
  font-weight: 600;
  font-size: var(--text-sm);
}
details[open] summary::after {
  content: 'Скрыть';
}
.journal {
  display: grid;
  grid-template-columns: 1fr 1.4fr;
  gap: var(--s-6);
  margin-top: var(--s-4);
}
.journal h3 {
  margin-bottom: var(--s-2);
}
.tech-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
  font-size: var(--text-sm);
}
.tech-list li {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  align-items: baseline;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--line);
}
@media (max-width: 1023px) {
  .grid,
  .journal {
    grid-template-columns: 1fr;
  }
  .fields {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 639px) {
  .fields {
    grid-template-columns: 1fr;
  }
}
.season {
  display: grid;
  gap: var(--space-2, 8px);
  justify-items: start;
  margin-bottom: var(--space-3, 12px);
  padding: var(--space-3, 12px);
  border-radius: var(--radius-md, 10px);
  background: var(--surface-2);
}
</style>
