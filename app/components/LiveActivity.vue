<script setup lang="ts">
const { state: d, failure } = useFarm()
const props = defineProps<{ busy?: boolean }>()
const emit = defineEmits<{ research: [] }>()
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval>
onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})
onUnmounted(() => clearInterval(timer))
const roles = [
  { key: 'search', name: 'Поиск', icon: '⌕', purpose: 'Находит источники' },
  { key: 'Исследователь', name: 'Исследователь', icon: '◎', purpose: 'Формулирует гипотезу' },
  { key: 'Критик', name: 'Критик', icon: '◇', purpose: 'Проверяет допущения' },
  { key: 'Архитектор', name: 'Архитектор', icon: '▦', purpose: 'Проектирует сервис' },
  { key: 'Исполнитель', name: 'Исполнитель', icon: '↗', purpose: 'Готовит результат' },
  { key: 'Проверяющий', name: 'Проверяющий', icon: '✓', purpose: 'Проверяет качество' },
]
const online = computed(
  () =>
    !failure.value &&
    d.value?.state.worker_heartbeat &&
    now.value - new Date(d.value.state.worker_heartbeat).getTime() < 30000,
)
const running = computed(() => d.value?.jobs.filter((j: any) => j.status === 'running') || [])
const queue = computed(() => d.value?.jobs.filter((j: any) => j.status === 'queued') || [])
const pending = computed(
  () =>
    d.value?.toolCalls.filter(
      (c: any) =>
        c.status === 'pending' &&
        running.value.some(
          (j: any) => j.id === c.job_id && new Date(j.locked_until).getTime() > now.value,
        ),
    ) || [],
)
const selected = ref('')
const job = computed(
  () =>
    d.value?.jobs.find((j: any) => j.id === selected.value) ||
    running.value[0] ||
    d.value?.jobs.find((j: any) => j.kind !== 'evaluate'),
)
const calls = computed(
  () =>
    d.value?.toolCalls
      .filter((c: any) => c.job_id === job.value?.id)
      .slice()
      .reverse() || [],
)
const current = computed(() => pending.value[0])
const researchRemaining = computed(() =>
  Math.max(0, d.value.config.manualResearchLimit - d.value.workload.manual_research_today),
)
const currentStrategy = computed(() => {
  if (!current.value) return ''
  const run = d.value.jobs.find((j: any) => j.id === current.value.job_id)
  if (run?.kind === 'fulfill')
    return (
      d.value.orders.find((o: any) => o.id === run.payload.orderId)?.strategy_snapshot?.name || ''
    )
  if (!run?.payload.plan) return ''
  const planned = JSON.parse(run.payload.plan).find(
    (item: any) => item.template === current.value.template,
  )
  return d.value.strategies.find((s: any) => s.id === planned?.strategy.id)?.name || ''
})
const summary = computed(() =>
  !online.value
    ? 'Нет свежего сигнала от worker'
    : d.value.state.mode === 'emergency_stop'
      ? 'Аварийный стоп включён'
      : current.value
        ? current.value.role === 'search'
          ? current.value.is_demo
            ? 'Поиск формирует демопример'
            : 'Поиск изучает интернет'
          : `${current.value.role} работает`
        : running.value.length
          ? 'Координатор выполняет задание'
          : d.value.state.mode === 'paused'
            ? 'Работа приостановлена'
            : queue.value.length
              ? 'Задание ожидает свободного исполнителя'
              : 'Сейчас нет активных заданий',
)
function elapsed(start: string, end?: string) {
  const seconds = Math.max(
    0,
    Math.floor(((end ? new Date(end).getTime() : now.value) - new Date(start).getTime()) / 1000),
  )
  return seconds < 60 ? `${seconds} с` : `${Math.floor(seconds / 60)} мин ${seconds % 60} с`
}
function roleState(key: string) {
  if (online.value && pending.value.some((c: any) => c.role === key)) return 'working'
  const last = calls.value.filter((c: any) => c.role === key).at(-1)
  return last?.status === 'done' ? 'complete' : last?.status === 'uncertain' ? 'issue' : 'waiting'
}
const jobHypotheses = computed(
  () => d.value?.hypotheses.filter((h: any) => h.job_id === job.value?.id) || [],
)
const roleStatus: Record<string, string> = {
  working: 'Работает',
  complete: 'Завершил этап',
  issue: 'Нужна проверка',
  waiting: 'Ожидает',
}
</script>

<template>
  <section v-if="d" class="panel live-lab" aria-label="Работа агентов в реальном времени">
    <div class="section-heading live-heading">
      <div>
        <span class="eyebrow">ПУЛЬТ ЛАБОРАТОРИИ</span>
        <h2>Что происходит прямо сейчас</h2>
      </div>
      <span class="subtle-tag"
        ><span class="dot" :class="online ? 'green' : 'amber'" />{{
          online ? 'Связь есть · обновление 2 с' : 'Нет свежих данных'
        }}</span
      >
    </div>
    <div class="live-focus" :class="{ 'is-working': online && pending.length }">
      <div class="live-beacon" :class="{ spinning: online && pending.length }" aria-hidden="true">
        {{ online && pending.length ? '◌' : '◎' }}
      </div>
      <div class="live-focus-copy">
        <h3 aria-live="polite">{{ summary }}</h3>
        <p>
          {{
            online && current
              ? current.task_label
              : !online
                ? 'Статусы ниже — последние сохранённые. Проверьте соединение и службу worker.'
                : 'Исследование запускается по расписанию или кнопкой. Заказы исполняются после тестовой оплаты.'
          }}
        </p>
        <span v-if="online && current" class="live-provider"
          >{{ current.model || current.provider
          }}<template v-if="currentStrategy"> · {{ currentStrategy }}</template> ·
          {{ labels[current.template] || 'Обработка заказа'
          }}<template v-if="current.is_demo"> · демонстрация</template></span
        >
      </div>
      <div class="live-timer">
        <strong>{{ online && current ? elapsed(current.created_at) : '—' }}</strong
        ><span>{{
          online && current
            ? current.progress_chars
              ? `${current.progress_chars} симв. сформировано`
              : 'Ожидаем ответ инструмента'
            : 'Нет выполняемого вызова'
        }}</span>
      </div>
    </div>
    <div class="agent-stations">
      <div v-for="role in roles" :key="role.key" class="agent-station" :class="roleState(role.key)">
        <span class="station-symbol" aria-hidden="true">{{ role.icon }}</span
        ><strong>{{ role.name }}</strong>
        <p>{{ role.purpose }}</p>
        <span class="station-state">{{ roleStatus[roleState(role.key)] }}</span>
      </div>
    </div>
    <div class="live-toolbar">
      <p>
        <strong>{{ online ? d.workload.running : '—' }}</strong> задач в работе <span>·</span>
        {{ d.workload.queued }} в очереди<br /><small
          >Дополнительных исследований осталось: {{ researchRemaining }}</small
        >
      </p>
      <button
        class="button primary small"
        :disabled="
          props.busy ||
          !online ||
          d.state.mode !== 'running' ||
          !d.state.research_enabled ||
          researchRemaining === 0 ||
          d.jobs.some((j: any) => j.kind === 'research' && ['queued', 'running'].includes(j.status))
        "
        @click="emit('research')"
      >
        {{
          d.jobs.some((j: any) => j.kind === 'research' && ['queued', 'running'].includes(j.status))
            ? 'Исследование выполняется…'
            : researchRemaining === 0
              ? 'Лимит дополнительных запусков использован'
              : 'Новое исследование ↗'
        }}
      </button>
    </div>
    <div class="live-details">
      <div class="run-history">
        <div class="run-history-heading">
          <h3>Ход выполнения</h3>
          <select v-if="job" v-model="selected" aria-label="Показать задание">
            <option value="">Текущее / последнее</option>
            <option v-for="j in d.jobs" :key="j.id" :value="j.id">
              {{ labels[j.kind] }} · {{ dateTime(j.created_at) }} · {{ labels[j.status] }}
            </option>
          </select>
        </div>
        <div v-if="!calls.length" class="empty">
          {{
            job?.status === 'running'
              ? 'Координатор готовит следующий этап.'
              : 'Подробная запись этапов доступна для новых запусков.'
          }}
        </div>
        <ol v-else class="call-timeline">
          <li v-for="call in calls" :key="call.id" :class="call.status">
            <span class="call-marker" aria-hidden="true">{{
              call.status === 'done' ? '✓' : call.status === 'uncertain' ? '!' : '·'
            }}</span>
            <details :open="call.status === 'pending' || call.status === 'uncertain'">
              <summary>
                <strong>{{ call.role === 'search' ? 'Поиск' : call.role }}</strong
                ><span>{{ labels[call.template] || 'Заказ' }}</span
                ><time>{{
                  call.finished_at
                    ? elapsed(call.created_at, call.finished_at)
                    : online && call.status === 'pending' && job?.status === 'running'
                      ? elapsed(call.created_at)
                      : '—'
                }}</time>
              </summary>
              <p>{{ call.task_label }}</p>
              <p v-if="call.status === 'done'" class="call-result">{{ call.resultSummary }}</p>
              <p v-else-if="call.status === 'uncertain'" class="error-text">
                {{ call.error_code || 'Исход вызова не подтверждён' }}. Этап не засчитан как
                успешный.
              </p>
              <p v-else class="muted">
                {{
                  online && job?.status === 'running'
                    ? 'Ответ ещё не завершён.'
                    : 'Завершение не подтверждено.'
                }}
                {{ call.progress_chars }} символов ответа получено.
              </p>
            </details>
          </li>
        </ol>
      </div>
      <aside class="run-outcome">
        <span class="eyebrow">РЕЗУЛЬТАТ ЗАПУСКА</span>
        <template v-if="job"
          ><h3>
            {{ labels[job.status] }} <small>№ {{ job.id.slice(0, 8) }}</small>
          </h3>
          <p v-if="job.error_code" class="error-text">Причина: {{ job.error_code }}</p>
          <p>
            {{ calls.filter((c: any) => c.status === 'done').length }} этапов завершено.
            {{ jobHypotheses.length }} гипотез сохранено.
          </p>
          <p v-for="h in jobHypotheses" :key="h.id" class="outcome-idea">
            <strong>{{ h.title }}</strong
            ><span>{{ labels[h.status] }} · {{ h.is_demo ? 'демо' : 'живое исследование' }}</span>
          </p>
          <NuxtLink v-if="jobHypotheses.length" to="/?view=hypotheses"
            >Открыть гипотезы и источники ↗</NuxtLink
          ><NuxtLink v-if="jobHypotheses.some((h: any) => h.status === 'accepted')" to="/catalog"
            >Посмотреть созданный продукт ↗</NuxtLink
          ></template
        >
        <p v-else>Первый результат появится после исследования.</p>
        <div class="next-run">
          <span>Следующий запуск по расписанию</span
          ><strong>{{
            d.config.autonomyEnabled && d.state.mode === 'running' && d.state.research_enabled
              ? dateTime(d.nextResearchAt)
              : 'Расписание приостановлено'
          }}</strong>
          <p>Дополнительно можно запустить до 3 исследований в сутки, с интервалом от 5 минут.</p>
        </div>
      </aside>
    </div>
  </section>
</template>
