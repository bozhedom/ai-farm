<script setup lang="ts">
import type {
  ComputerApprovalView,
  ComputerStepView,
  ComputerTaskView,
  ComputerUseView,
} from '../../../core/contracts/computer-use'
import { useOfficeAction } from '~/composables/office/actions'
import { ago, rub, when } from '~/composables/office/format'
import { officeFetch, useOfficeResource } from '~/composables/office/resource'
import {
  actionText,
  computerReason,
  opportunityKindLabel,
  stepBadge,
  taskStatusBadge,
  usd,
} from '~/utils/computer'

useHead({ title: 'Компьютер ИИ' })
const { data, status, pending, refresh } = useOfficeResource<ComputerUseView>(
  'computer-use',
  () => officeFetch<ComputerUseView>('/api/computer-use'),
  { interval: 5000 },
)
const { busy, run } = useOfficeAction()
const goal = ref('')
const goalError = ref('')

const post = (url: string, body: Record<string, unknown>) =>
  officeFetch<ComputerUseView>(url, { method: 'POST', body })

const state = computed(() => data.value?.state)
const current = computed(() => data.value?.current ?? null)
const issues = computed(() => {
  const s = state.value
  if (!s) return []
  const codes = [...s.blocked]
  if (s.lastError && !codes.includes(s.lastError)) codes.push(s.lastError)
  return [...new Set(codes.map(computerReason).filter(Boolean))]
})
const stateLabel = computed(() => {
  const s = state.value
  if (!s) return ''
  if (!s.enabled) return 'Выключено'
  if (current.value?.status === 'waiting_approval') return 'Ждёт вашего решения'
  if (s.running) return 'Работает в браузере'
  if (s.blocked.length) return 'Ждёт условий для запуска'
  return 'Готов к следующему заданию'
})
const stateBadge = computed(() => {
  const s = state.value
  if (!s || !s.enabled) return { label: 'Выключено', tone: 'off' as const }
  if (current.value?.status === 'waiting_approval')
    return { label: 'Нужно решение', tone: 'wait' as const }
  if (s.running) return { label: 'Работает', tone: 'ok' as const }
  return { label: 'Ожидание', tone: 'wait' as const }
})
const screenshotUrl = computed(() =>
  current.value?.latestScreenshotStepId
    ? `/api/computer-use/steps/${current.value.latestScreenshotStepId}/screenshot.png`
    : '',
)
const spentLine = (task: ComputerTaskView) =>
  task.demo ? 'демо, без расходов' : `${usd(task.spentMicrousd)} · ${rub(task.spentKopecks)}`
const stepLine = (step: ComputerStepView) => actionText(step.action as { name: string })
const shortGoal = (text: string) => (text.length > 140 ? `${text.slice(0, 140)}…` : text)
const sourceLabel = (task: ComputerTaskView) =>
  task.source === 'owner' ? 'Ваше задание' : 'Задание по ротации'
const taskNote = (task: ComputerTaskView) => (task.error ? computerReason(task.error) : task.report)
const approvalWhy = (approval: ComputerApprovalView) =>
  /^[A-Z][A-Z0-9_]{2,80}$/.test(approval.reason) ? computerReason(approval.reason) : approval.reason

function toggle() {
  const s = state.value
  if (!s) return
  void run(
    'toggle',
    () => post('/api/computer-use/control', { action: s.enabled ? 'pause' : 'enable' }),
    s.enabled ? 'Работа в браузере выключена.' : 'Работа в браузере включена.',
  ).then(() => refresh())
}
function decide(approval: ComputerApprovalView, decision: 'approve' | 'reject') {
  void run(
    `approval-${approval.id}`,
    () => post(`/api/computer-use/approvals/${approval.id}`, { decision }),
    decision === 'approve' ? 'Действие разрешено.' : 'Действие отклонено.',
  ).then(() => refresh())
}
function cancel(task: ComputerTaskView) {
  void run(
    'cancel',
    () => post('/api/computer-use/control', { action: 'cancel', taskId: task.id }),
    'Задание отменено.',
  ).then(() => refresh())
}
async function submitGoal() {
  goalError.value = ''
  const text = goal.value.trim()
  if (text.length < 10) {
    goalError.value = 'Опишите задание хотя бы десятью символами.'
    return
  }
  const result = await run(
    'goal',
    () => post('/api/computer-use/goals', { goal: text }),
    'Задание поставлено в очередь.',
  )
  if (result) goal.value = ''
  await refresh()
}
function mark(id: string, status: 'saved' | 'dismissed' | 'new') {
  void run(`opportunity-${id}`, () =>
    post(`/api/computer-use/opportunities/${id}`, { status }),
  ).then(() => refresh())
}
</script>
<template>
  <div>
    <div class="page-head">
      <div>
        <h1>Компьютер ИИ</h1>
        <p>
          Модель сама ходит по сайтам в браузере на отдельной машине, ищет законные способы
          заработка и записывает находки. Деньги, пароли, регистрации и публикации ждут вашего
          решения.
        </p>
      </div>
    </div>

    <OfficeState
      v-if="!data || !state"
      :status="status"
      :pending="pending"
      :rows="4"
      @retry="refresh"
    />
    <template v-else>
      <section class="card rise control" aria-labelledby="computer-state">
        <div class="switch-row">
          <div>
            <h2 id="computer-state" class="state-title">
              {{ stateLabel }} <OfficeBadge :badge="stateBadge" />
            </h2>
            <p class="small muted">
              {{
                state.demo
                  ? 'Демонстрационный режим: сценарий без настоящей модели и без машины, сеть не используется.'
                  : `Модель ${state.model}, шагов на задание до ${state.stepLimit}, не дороже ${usd(state.taskCapMicrousd)} за задание и ${usd(state.dailyCapMicrousd)} в сутки.`
              }}
            </p>
          </div>
          <button
            type="button"
            class="switch"
            role="switch"
            :aria-checked="state.enabled"
            aria-label="Работа модели в браузере"
            :disabled="!!busy || status.offline"
            @click="toggle"
          />
        </div>
        <ul v-if="issues.length" class="issues">
          <li v-for="issue in issues" :key="issue">{{ issue }}</li>
        </ul>
        <p v-if="state.blocked.includes('COMPUTER_USE_SYSTEM_PAUSED')" class="small">
          <NuxtLink to="/office/settings">Открыть настройки</NuxtLink>
        </p>
      </section>

      <section class="stat-grid stats" aria-label="Расходы и лимиты">
        <div class="stat rise">
          <span class="stat-label">Расходы сегодня</span>
          <span class="num">{{ usd(state.spentTodayMicrousd) }}</span>
          <span class="stat-note"
            >{{ rub(state.spentTodayKopecks) }} из {{ usd(state.dailyCapMicrousd) }} в сутки</span
          >
        </div>
        <div class="stat rise">
          <span class="stat-label">Одно задание</span>
          <span class="num">{{ usd(state.taskCapMicrousd) }}</span>
          <span class="stat-note">до {{ state.stepLimit }} шагов</span>
        </div>
        <div class="stat rise">
          <span class="stat-label">В очереди</span>
          <span class="num">{{ state.queuedOwnerGoals }}</span>
          <span class="stat-note">ваших заданий, затем {{ state.rotationGoals }} тем по кругу</span>
        </div>
        <div class="stat rise">
          <span class="stat-label">Найдено</span>
          <span class="num">{{ data.opportunities.length }}</span>
          <span class="stat-note">возможностей для проверки</span>
        </div>
      </section>

      <section
        v-if="data.approvals.length"
        class="card rise approvals card-tint-sun"
        aria-labelledby="computer-approvals"
      >
        <div class="card-head">
          <h2 id="computer-approvals">Нужно ваше решение</h2>
          <span class="small muted">Пока вы не ответите, задание стоит</span>
        </div>
        <div class="rows">
          <div v-for="approval in data.approvals" :key="approval.id" class="approval">
            <p class="small muted">Шаг {{ approval.stepNo }} · {{ shortGoal(approval.goal) }}</p>
            <p class="strong">{{ actionText(approval.action) }}</p>
            <p class="small">{{ approvalWhy(approval) }}</p>
            <div class="row-wrap actions">
              <button
                type="button"
                class="btn btn-primary btn-sm"
                :disabled="!!busy"
                @click="decide(approval, 'approve')"
              >
                <OfficeIcon name="check" size="sm" />Разрешить
              </button>
              <button
                type="button"
                class="btn btn-sm"
                :disabled="!!busy"
                @click="decide(approval, 'reject')"
              >
                <OfficeIcon name="close" size="sm" />Отклонить
              </button>
            </div>
          </div>
        </div>
      </section>

      <section class="card rise current" aria-labelledby="computer-current">
        <div class="card-head">
          <h2 id="computer-current">Текущее задание</h2>
          <OfficeBadge v-if="current" :badge="taskStatusBadge[current.status]" />
        </div>
        <template v-if="current">
          <p class="goal">{{ current.goal }}</p>
          <p class="small muted">
            {{ sourceLabel(current) }} · шаг {{ current.stepCount }} из {{ current.stepLimit }} ·
            {{ spentLine(current) }} · начато {{ ago(current.startedAt || current.createdAt) }}
            <span v-if="current.demo" class="badge badge-plain demo-note">Демо</span>
          </p>
          <div class="live">
            <figure class="screen">
              <img
                v-if="screenshotUrl"
                :key="screenshotUrl"
                :src="screenshotUrl"
                alt="Последний снимок экрана браузера"
                width="1280"
                height="800"
              />
              <div v-else class="screen-empty muted small">Снимок появится после первого шага.</div>
              <figcaption class="small muted">
                {{
                  current.steps[0]?.urlAfter ||
                  current.steps[0]?.urlBefore ||
                  'Браузер ещё не открыл страницу'
                }}
              </figcaption>
            </figure>
            <ol class="log" aria-label="Журнал шагов">
              <li v-for="step in current.steps" :key="step.id">
                <div class="log-head">
                  <span class="mono small">{{ step.stepNo }}</span>
                  <OfficeBadge :badge="stepBadge[step.decision]" />
                  <span class="small muted">{{ when(step.createdAt) }}</span>
                </div>
                <p class="log-action">{{ stepLine(step) }}</p>
                <p v-if="step.reason" class="small muted">{{ computerReason(step.reason) }}</p>
                <p v-if="step.reasoning" class="small quote">{{ step.reasoning }}</p>
              </li>
              <li v-if="!current.steps.length" class="muted small">Шагов ещё нет.</li>
            </ol>
          </div>
          <div class="row-wrap actions">
            <button
              type="button"
              class="btn btn-sm btn-danger"
              :disabled="!!busy"
              @click="cancel(current)"
            >
              Отменить задание
            </button>
          </div>
        </template>
        <OfficeEmpty
          v-else
          icon="eye"
          title="Сейчас ничего не выполняется"
          :text="
            state.enabled
              ? 'Следующее задание начнётся, как только worker освободится и условия позволят.'
              : 'Включите работу выше, чтобы модель начала искать возможности.'
          "
        />
      </section>

      <section class="card rise" aria-labelledby="computer-goal">
        <h2 id="computer-goal">Своё задание</h2>
        <p class="small muted">
          Опишите, что найти или проверить в интернете. Задание выполняется раньше тем по кругу;
          запрещённые темы сервер отклонит.
        </p>
        <form class="goal-form" @submit.prevent="submitGoal">
          <div class="field" :class="{ 'is-error': goalError }">
            <label for="computer-goal-text">Что сделать</label>
            <textarea
              id="computer-goal-text"
              v-model="goal"
              class="textarea"
              rows="3"
              maxlength="1000"
              placeholder="Например: найди конкурсы для разработчиков ИИ-агентов с дедлайном в ближайший месяц"
            />
            <p v-if="goalError" class="hint">{{ goalError }}</p>
          </div>
          <button type="submit" class="btn btn-primary" :disabled="!!busy || status.offline">
            {{ busy === 'goal' ? 'Сохраняем' : 'Поставить в очередь' }}
          </button>
        </form>
      </section>

      <section class="card rise" aria-labelledby="computer-found">
        <div class="card-head">
          <h2 id="computer-found">Найденные возможности</h2>
          <span class="small muted">Записи для проверки человеком, не доход</span>
        </div>
        <div v-if="data.opportunities.length" class="rows">
          <article
            v-for="item in data.opportunities"
            :key="item.id"
            class="found"
            :class="{ 'is-off': item.status === 'dismissed' }"
          >
            <div class="found-head">
              <span class="badge badge-plain">{{
                opportunityKindLabel[item.kind] || item.kind
              }}</span>
              <span v-if="item.requiresHuman" class="badge badge-human">Нужен человек</span>
              <span v-if="item.demo" class="badge badge-test">Демо</span>
              <span v-if="item.status === 'saved'" class="badge badge-ok">Сохранено</span>
              <span class="small muted">{{ when(item.createdAt) }}</span>
            </div>
            <h3>{{ item.title }}</h3>
            <p class="small">{{ item.summary }}</p>
            <p class="small">
              <a :href="item.url" target="_blank" rel="noopener noreferrer nofollow">{{
                item.url
              }}</a>
            </p>
            <div class="row-wrap actions">
              <button
                v-if="item.status !== 'saved'"
                type="button"
                class="btn btn-sm"
                :disabled="!!busy"
                @click="mark(item.id, 'saved')"
              >
                Сохранить
              </button>
              <button
                v-if="item.status !== 'dismissed'"
                type="button"
                class="btn btn-sm btn-ghost"
                :disabled="!!busy"
                @click="mark(item.id, 'dismissed')"
              >
                Не подходит
              </button>
              <button
                v-else
                type="button"
                class="btn btn-sm btn-ghost"
                :disabled="!!busy"
                @click="mark(item.id, 'new')"
              >
                Вернуть
              </button>
            </div>
          </article>
        </div>
        <p v-else class="muted">Пока ничего не найдено. Записи появятся по ходу заданий.</p>
      </section>

      <section class="card rise" aria-labelledby="computer-history">
        <div class="card-head">
          <h2 id="computer-history">История заданий</h2>
        </div>
        <div v-if="data.history.length" class="table-wrap">
          <table class="table table-stack">
            <thead>
              <tr>
                <th>Когда</th>
                <th>Задание</th>
                <th>Статус</th>
                <th>Шаги</th>
                <th>Расходы</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="task in data.history" :key="task.id">
                <td data-l="Когда" class="mono small">
                  {{ when(task.finishedAt || task.createdAt) }}
                </td>
                <td data-l="Задание" data-full>
                  <p>{{ shortGoal(task.goal) }}</p>
                  <p class="small muted">
                    {{ sourceLabel(task) }}<span v-if="task.demo"> · демо</span>
                  </p>
                  <details v-if="taskNote(task)" class="disclosure">
                    <summary class="small">{{ task.error ? 'Причина' : 'Отчёт' }}</summary>
                    <p class="small report">{{ taskNote(task) }}</p>
                  </details>
                </td>
                <td data-l="Статус"><OfficeBadge :badge="taskStatusBadge[task.status]" /></td>
                <td data-l="Шаги">{{ task.stepCount }} из {{ task.stepLimit }}</td>
                <td data-l="Расходы" class="mono small">{{ spentLine(task) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="muted">Заданий ещё не было.</p>
      </section>

      <details class="card rise disclosure help">
        <summary>Как это устроено</summary>
        <p>
          Браузер работает на отдельной виртуальной машине без ключей бирж, кошельков и базы фермы.
          Модель видит снимок экрана и предлагает одно действие; сервер проверяет его по правилам и
          только потом передаёт машине. Каждый шаг заранее резервирует расход модели в общем журнале
          с теми же дневными и месячными лимитами.
        </p>
        <p>
          Сама модель может открывать сайты, искать, читать и заполнять поисковые формы. Оплата,
          пароли, регистрация, публикации, сообщения людям, принятие условий и переводы ждут вашего
          решения выше. Обход капч и проверок, мультиаккаунты и чужие документы запрещены на
          сервере.
        </p>
        <p>
          Найденные возможности это записи для проверки человеком. Они не считаются доходом и не
          создают обязательств. Аккаунты на площадках регистрирует человек; двухфакторные коды
          остаются у него.
        </p>
      </details>
    </template>
  </div>
</template>
<style scoped>
.control,
.stats,
.approvals,
.current {
  margin-bottom: var(--s-5);
}
section.card + section.card,
section.card + details.card {
  margin-top: var(--s-5);
}
.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-4);
}
.state-title {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex-wrap: wrap;
}
.issues {
  margin: var(--s-3) 0 0;
  padding-left: 18px;
  line-height: 1.7;
  color: var(--st-wait-ink);
}
.approval + .approval {
  padding-top: var(--s-4);
}
.approval .strong {
  font-weight: 600;
  margin: 2px 0;
}
.actions {
  margin-top: var(--s-3);
  gap: var(--s-2);
}
.goal {
  font-weight: 600;
  margin-bottom: 4px;
}
.demo-note {
  margin-left: 6px;
  vertical-align: 1px;
}
.live {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  gap: var(--s-5);
  margin-top: var(--s-4);
}
.screen {
  margin: 0;
  min-width: 0;
}
.screen img {
  display: block;
  width: 100%;
  height: auto;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--canvas-deep);
}
.screen-empty {
  aspect-ratio: 16 / 10;
  display: grid;
  place-items: center;
  border: 1px dashed var(--line-strong);
  border-radius: var(--r-md);
}
.screen figcaption {
  margin-top: 6px;
  word-break: break-all;
}
.log {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 520px;
  overflow: auto;
  display: grid;
  gap: var(--s-3);
  min-width: 0;
}
.log li {
  padding-bottom: var(--s-3);
  border-bottom: 1px solid var(--line);
}
.log-head {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex-wrap: wrap;
}
.log-action {
  margin-top: 4px;
  word-break: break-word;
}
.quote {
  margin-top: 4px;
  padding-left: var(--s-3);
  border-left: 2px solid var(--line-strong);
  color: var(--muted);
}
.goal-form {
  display: grid;
  gap: var(--s-3);
  margin-top: var(--s-3);
  justify-items: start;
}
.goal-form .field {
  width: 100%;
}
.found-head {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex-wrap: wrap;
  margin-bottom: 4px;
}
.found h3 {
  margin-bottom: 4px;
}
.found a {
  word-break: break-all;
}
.found.is-off h3,
.found.is-off p {
  color: var(--muted);
}
.report {
  white-space: pre-line;
  margin-top: 4px;
}
.help p + p {
  margin-top: var(--s-3);
}
@media (max-width: 900px) {
  .live {
    grid-template-columns: 1fr;
  }
  .log {
    max-height: 360px;
  }
}
</style>
