<script setup lang="ts">
import type { ManagerView } from '../../../core/contracts/manager'
import { exchangeCatalog } from '../../../core/trading/catalog'
import { exchanges } from '../../../core/trading/types'
import { officeFetch, useOfficeResource } from '~/composables/office/resource'
import { managerReason, managerRub } from '~/utils/manager'
import { shortTime } from '~/utils/trading'

useHead({ title: 'Менеджер торговли' })
const { data, pending, status, refresh } = useOfficeResource<ManagerView>(
  () => 'trading-manager',
  () => officeFetch('/api/trading/manager'),
  { interval: 10_000 },
)
const busy = ref('')
const error = ref('')
const notice = ref('')
const tasks = computed(() =>
  [...(data.value?.tasks || [])].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
)
const boards = computed(() =>
  exchanges.map((exchange) => {
    const all = tasks.value.filter((task) => task.exchange === exchange)
    const active = all.filter((task) => ['queued', 'observing'].includes(task.status))
    return {
      exchange,
      name: exchangeCatalog[exchange].name,
      tasks: active.length ? active : all.slice(0, 1),
    }
  }),
)
const previousTasks = computed(() => {
  const shown = new Set(boards.value.flatMap((board) => board.tasks.map((task) => task.id)))
  return tasks.value.filter((task) => !shown.has(task.id))
})
const runs = computed(() =>
  [...(data.value?.runs || [])].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
)
const latestSummary = computed(() =>
  runs.value.find((run) => run.status === 'completed' && run.summary),
)
const working = computed(
  () => !!data.value && (data.value.state.thinking || data.value.state.requested),
)
const stateLabel = computed(() => {
  if (!data.value) return ''
  const state = data.value.state
  if (!state.enabled) return state.thinking ? 'Выключен, разбор завершается' : 'Выключен'
  if (state.thinking) return 'Разбирает результаты'
  if (state.requested) return 'Разбор запрошен'
  if (state.blocked.length || !state.workerAlive) return 'Ждёт условий для разбора'
  return 'Работает по расписанию'
})
const canReview = computed(() => {
  const state = data.value?.state
  return (
    !!state &&
    state.enabled &&
    !working.value &&
    !busy.value &&
    !status.value.offline &&
    state.workerAlive &&
    !state.blocked.length &&
    state.runsToday < state.maxDailyRuns &&
    state.spentKopecks + state.reservedKopecks < state.dailyLimitKopecks
  )
})
const issues = computed(() => {
  const state = data.value?.state
  if (!state) return []
  const codes = [...state.blocked]
  if (state.lastError) codes.push(state.lastError)
  return [...new Set(codes.map(managerReason).filter(Boolean))]
})

async function control(action: 'enable' | 'pause' | 'review') {
  if (busy.value || (action === 'review' && !canReview.value)) return
  busy.value = action
  error.value = ''
  notice.value = ''
  try {
    await officeFetch<ManagerView>('/api/trading/manager/control', {
      method: 'POST',
      body: { action },
    })
    notice.value =
      action === 'enable'
        ? 'Менеджер включён. Состояние первого разбора появится здесь.'
        : action === 'pause'
          ? 'Менеджер выключен. Уже торгующие агенты продолжают работать.'
          : 'Разбор запрошен. Сводка и новые задачи появятся на этой странице.'
    await refresh()
  } catch (cause) {
    const failure = cause as { data?: { statusMessage?: string }; status?: number }
    error.value =
      failure.status === 401
        ? 'Сессия завершилась. Войдите снова.'
        : failure.data?.statusMessage
          ? managerReason(failure.data.statusMessage)
          : 'Не удалось сохранить действие. Проверьте соединение и повторите.'
  } finally {
    busy.value = ''
  }
}
</script>
<template>
  <div class="trading-workspace manager-workspace">
    <div class="trading-main">
      <div class="page-heading">
        <div>
          <h1>Менеджер торговли</h1>
          <p class="t-muted">
            Подбирает стратегии, сравнивает результаты и ставит задачи в тренировке.
          </p>
        </div>
      </div>
      <p v-if="status.offline" class="t-notice t-warning" role="alert">
        Нет связи с сервером. Показываем последнее состояние; управление временно недоступно.
      </p>
      <p v-if="pending" class="manager-loading" role="status">Получаем состояние менеджера…</p>
      <div v-else-if="!data" class="t-empty">
        <h2>Состояние пока недоступно</h2>
        <p>Проверьте соединение и повторите загрузку.</p>
        <button class="t-button" @click="refresh()">Повторить</button>
      </div>
      <template v-else>
        <section class="manager-control" aria-labelledby="manager-control-title">
          <div class="manager-control-heading">
            <div>
              <h2 id="manager-control-title">{{ stateLabel }}</h2>
              <p class="manager-caption">
                Разбор раз в {{ data.state.intervalHours }} ч. Сегодня {{ data.state.runsToday }} из
                {{ data.state.maxDailyRuns }}.
              </p>
            </div>
            <div class="manager-actions">
              <button
                class="t-button"
                :class="{ 't-primary': !data.state.enabled }"
                :disabled="!!busy || status.offline"
                @click="control(data.state.enabled ? 'pause' : 'enable')"
              >
                {{
                  busy === 'enable' || busy === 'pause'
                    ? 'Сохраняем…'
                    : data.state.enabled
                      ? 'Выключить менеджера'
                      : 'Включить менеджера'
                }}
              </button>
              <button class="t-link" :disabled="!canReview" @click="control('review')">
                {{
                  data.state.thinking
                    ? 'Идёт разбор…'
                    : data.state.requested
                      ? 'Разбор запрошен'
                      : 'Разобрать сейчас'
                }}
              </button>
            </div>
          </div>
          <p
            v-if="data.state.enabled && data.state.nextReviewAt && !working"
            class="manager-caption"
          >
            Следующий разбор {{ shortTime(data.state.nextReviewAt) }}.
          </p>
          <p v-if="data.state.demo" class="t-notice manager-demo">
            Демонстрационный режим: разборы по готовым примерам.
          </p>
          <p v-if="!data.state.workerAlive" class="t-notice t-warning">
            Связь потеряна. Новые разборы продолжатся после её восстановления.
          </p>
          <ul v-if="issues.length" class="manager-issues">
            <li v-for="issue in issues" :key="issue">{{ issue }}</li>
          </ul>
          <NuxtLink
            v-if="data.state.blocked.includes('MANAGER_SYSTEM_PAUSED')"
            to="/office/settings"
            class="t-link"
            >Открыть настройки</NuxtLink
          >
          <p v-if="notice" class="t-notice" role="status">{{ notice }}</p>
          <p v-if="error" class="t-notice t-warning" role="alert">{{ error }}</p>
          <p class="manager-caption manager-scope">
            Работает только с уже запущенной тренировкой и меняет свободных агентов. Выключение
            менеджера не останавливает их торговлю.
          </p>
        </section>

        <section class="manager-summary" aria-labelledby="manager-summary-title">
          <div class="section-heading">
            <h2 id="manager-summary-title">Последний разбор</h2>
            <span v-if="latestSummary" class="manager-caption">{{
              shortTime(latestSummary.finishedAt || latestSummary.createdAt)
            }}</span>
          </div>
          <template v-if="latestSummary">
            <span v-if="latestSummary.demo" class="manager-demo-label"
              >Демонстрационная сводка</span
            >
            <p class="manager-summary-text">{{ latestSummary.summary }}</p>
          </template>
          <p v-else class="t-muted">
            {{
              working
                ? 'Менеджер готовит первый разбор. Дождитесь результата.'
                : data.state.enabled
                  ? 'Первый разбор появится после проверки работающей тренировки.'
                  : 'Включите менеджера, чтобы он начал разбирать тренировку и предлагать эксперименты.'
            }}
          </p>
        </section>

        <section class="manager-experiments" aria-labelledby="manager-tasks-title">
          <div class="section-heading">
            <div>
              <h2 id="manager-tasks-title">Задачи по биржам</h2>
              <p class="manager-caption">
                Каждая идея проверяется отдельно, на виртуальных деньгах.
              </p>
            </div>
            <NuxtLink class="t-link" to="/office/trading">Открыть торговлю</NuxtLink>
          </div>
          <div class="manager-boards">
            <section
              v-for="board in boards"
              :key="board.exchange"
              class="manager-board"
              :aria-labelledby="`manager-${board.exchange}`"
            >
              <h3 :id="`manager-${board.exchange}`">{{ board.name }}</h3>
              <ManagerTask v-for="task in board.tasks" :key="task.id" :task="task" />
              <p v-if="!board.tasks.length" class="manager-no-task">
                Задач пока нет. Они появятся после разбора результатов этой биржи.
              </p>
            </section>
          </div>
        </section>

        <section class="manager-cost" aria-labelledby="manager-cost-title">
          <div>
            <h2 id="manager-cost-title">Расходы на модель сегодня</h2>
            <p class="manager-caption">
              Учитываются отдельно от результата торговли. День считается по UTC.
            </p>
          </div>
          <div class="manager-cost-value">
            <p>
              <strong>{{ managerRub(data.state.spentKopecks) }}</strong>
              <span class="t-muted">из {{ managerRub(data.state.dailyLimitKopecks) }}</span>
            </p>
            <p v-if="data.state.reservedKopecks" class="manager-caption">
              Зарезервировано {{ managerRub(data.state.reservedKopecks) }}.
            </p>
          </div>
        </section>

        <details class="manager-history manager-details">
          <summary>История разборов и прежние задачи</summary>
          <p v-if="!runs.length && !previousTasks.length" class="t-muted">
            История появится после первого разбора.
          </p>
          <ol v-if="runs.length" class="manager-runs">
            <li v-for="run in runs" :key="run.id">
              <div class="manager-run-heading">
                <strong>{{ run.demo ? 'Демонстрационный разбор' : 'Разбор тренировки' }}</strong>
                <span class="manager-caption"
                  >{{ shortTime(run.createdAt) }} · {{ managerRub(run.costKopecks) }}</span
                >
              </div>
              <p v-if="run.status === 'running'" class="t-muted">Модель ещё готовит ответ.</p>
              <p v-else-if="run.status === 'discarded'" class="t-muted">
                Результат разбора не применён.
              </p>
              <p v-if="run.summary">{{ run.summary }}</p>
              <p v-if="run.error" class="manager-task-reason">{{ managerReason(run.error) }}</p>
              <p v-else-if="run.status === 'failed'" class="manager-task-reason">
                Разбор не завершился. Изменения не применены.
              </p>
            </li>
          </ol>
          <div v-for="task in previousTasks" :key="task.id" class="manager-previous-task">
            <h3>{{ exchangeCatalog[task.exchange].name }}</h3>
            <ManagerTask :task="task" />
          </div>
        </details>

        <details class="manager-help manager-details">
          <summary>Как работает менеджер</summary>
          <p>
            Менеджер предлагает новые настройки неприбыльным агентам с историей от 24 часов.
            Изменения вступают в силу после закрытия позиций и завершения ордеров. Прибыльные агенты
            продолжают работать со своими настройками.
          </p>
          <p>
            Менеджер не запускает торговлю и не снимает её риск-паузу. Счета «Тест биржи» и
            «Реальная торговля» он не меняет. Выключение менеджера не останавливает уже торгующих
            агентов; ими управляют в разделе «Мои биржи».
          </p>
          <p>
            Автоматический разбор идёт раз в {{ data.state.intervalHours }} ч, не более
            {{ data.state.maxDailyRuns }} разборов за сутки UTC. Ручной запрос доступен не чаще
            одного раза в {{ data.state.manualCooldownMinutes }} мин. и использует тот же лимит.
          </p>
          <p>
            Ранняя оценка появляется не раньше чем через {{ data.state.minEvaluationHours }} ч и
            после {{ data.state.minRoundTrips }} закрытых позиций. Наблюдение длится не более
            {{ data.state.maxObservationDays }} дн. Результаты тренировки не дают автоматического
            допуска к реальной торговле.
          </p>
          <dl class="manager-facts">
            <div>
              <dt>Провайдер модели</dt>
              <dd>{{ data.state.provider }}</dd>
            </div>
            <div>
              <dt>Модель</dt>
              <dd>{{ data.state.model }}</dd>
            </div>
          </dl>
        </details>
      </template>
    </div>
  </div>
</template>
<style src="../../assets/trading.css"></style>
<style src="../../assets/manager.css"></style>
