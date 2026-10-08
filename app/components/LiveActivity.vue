<script setup lang="ts">
import type { Template } from '../../core/policy'
import { stageState, stageLabels } from '~/utils/activity'

const { state: d, failure } = useFarm()
const { services, serviceLabel, researchBlockedReason } = useServiceCatalog()
const props = defineProps<{ busy?: boolean }>()
const emit = defineEmits<{ research: [template?: Template] }>()
const researchTemplate = useState<Template | ''>('research-template', () => '')
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
    now.value - new Date(d.value.state.worker_heartbeat).getTime() < 90000,
)
const running = computed(() => d.value?.jobs.filter((j: any) => j.status === 'running') || [])
const queue = computed(() => d.value?.jobs.filter((j: any) => j.status === 'queued') || [])
const pending = computed(
  () =>
    d.value?.toolCalls.filter(
      (c: any) =>
        c.status === 'pending' &&
        c.job_id === job.value?.id &&
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
    queue.value.find((j: any) => j.kind !== 'evaluate') ||
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
const researchActive = computed(() =>
  d.value?.jobs.some((j: any) => j.kind === 'research' && ['queued', 'running'].includes(j.status)),
)
const researchDisabled = computed(
  () =>
    !d.value ||
    props.busy ||
    !online.value ||
    !!researchBlockedReason.value ||
    d.value.state.mode !== 'running' ||
    !d.value.state.research_enabled ||
    researchActive.value,
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
    ? 'Нет связи с обработчиком'
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
              ? 'Задание в очереди · ожидает запуска'
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
  return stageState(
    key,
    calls.value,
    pending.value.map((c: any) => c.role),
    !!online.value,
    ['done', 'failed'].includes(job.value?.status),
  )
}
const jobHypotheses = computed(
  () => d.value?.hypotheses.filter((h: any) => h.job_id === job.value?.id) || [],
)
const measuredCalls = computed(() =>
  calls.value.filter((c: any) => c.input_tokens != null && c.output_tokens != null),
)
const usage = computed(() => ({
  input: measuredCalls.value.reduce((n: number, c: any) => n + c.input_tokens, 0),
  output: measuredCalls.value.reduce((n: number, c: any) => n + c.output_tokens, 0),
  cost: calls.value.reduce((n: number, c: any) => n + c.charged_kopecks, 0),
  dollars: calls.value.reduce((n: number, c: any) => n + c.charged_microusd, 0),
  actualDollars: calls.value.reduce((n: number, c: any) => n + (c.actual_microusd ?? 0), 0),
  reasoning: calls.value.reduce((n: number, c: any) => n + (c.reasoning_tokens ?? 0), 0),
}))
const cloudCalls = computed(() =>
  calls.value.some((c: any) => ['openai', 'openrouter'].includes(c.provider)),
)
const sources = computed(() =>
  calls.value
    .flatMap((c: any) => c.sources || [])
    .filter(
      (source: any, i: number, all: any[]) => all.findIndex((s: any) => s.url === source.url) === i,
    ),
)
const draftIdea = computed(() => calls.value.findLast((c: any) => c.idea)?.idea)
const critic = computed(() =>
  calls.value.findLast((c: any) => c.role === 'Критик' && c.status === 'done'),
)
const shownRoles = computed(() => (job.value?.kind === 'fulfill' ? roles.slice(4) : roles))
const count = (value: number) => new Intl.NumberFormat('ru-RU').format(value)
const historical = computed(
  () => !!selected.value && !['running', 'queued'].includes(job.value?.status),
)
const focusedSummary = computed(() => (historical.value ? 'Сохранённый запуск' : summary.value))
</script>

<template>
  <section v-if="d" class="panel live-lab" aria-label="Работа агентов в реальном времени">
    <div class="section-heading live-heading">
      <div>
        <span class="eyebrow">ХОД РАБОТЫ</span>
        <h2>Ход исследования</h2>
      </div>
      <span class="subtle-tag"
        ><span class="dot" :class="online ? 'green' : 'amber'" />{{
          online ? 'Связь есть · обновление 2 с' : 'Нет свежих данных'
        }}</span
      >
    </div>
    <div class="lab-config">
      <span
        ><i class="dot" :class="d.config.modelProvider === 'demo' ? 'amber' : 'green'" />
        {{ d.config.model }}
        <small>{{
          d.config.modelProvider === 'ollama'
            ? 'настоящий ИИ · локально'
            : d.config.modelProvider === 'demo'
              ? 'шаблонные ответы'
              : 'облачный ИИ'
        }}</small>
      </span>
      <span
        >Поиск
        <strong>{{
          d.config.searchProvider === 'searxng'
            ? 'SearXNG · интернет'
            : d.config.searchProvider === 'yandex'
              ? 'Yandex Search API'
              : 'демоисточники'
        }}</strong></span
      >
      <span>{{
        d.config.modelProvider === 'ollama' && d.config.searchProvider === 'searxng'
          ? 'Без платы за API · используются ресурсы компьютера'
          : d.config.modelProvider === 'demo'
            ? 'Внешних запросов нет'
            : 'Расходы ограничены общим бюджетом'
      }}</span>
    </div>
    <div class="live-focus" :class="{ 'is-working': online && pending.length }">
      <div class="live-instrument" :class="{ active: online && pending.length }" aria-hidden="true">
        <svg viewBox="0 0 120 120" fill="none">
          <circle class="instrument-orbit" cx="60" cy="60" r="49" />
          <circle class="instrument-ring" cx="60" cy="60" r="37" />
          <path class="instrument-cross" d="M60 3v12M60 105v12M3 60h12M105 60h12" />
          <g class="instrument-particle"><circle cx="60" cy="11" r="4" /></g>
        </svg>
        <span>{{
          online && current
            ? roles.find((r) => r.key === current.role)?.icon || '◎'
            : job?.status === 'failed'
              ? '!'
              : '◎'
        }}</span>
      </div>
      <div class="live-focus-copy">
        <span class="focus-caption">{{ historical ? 'ИСТОРИЯ ЛАБОРАТОРИИ' : 'ПРЯМО СЕЙЧАС' }}</span>
        <h3 aria-live="polite">{{ focusedSummary }}</h3>
        <p>
          {{
            online && current
              ? current.task_label
              : !online
                ? 'Показаны последние статусы. Проверьте соединение и обработчик.'
                : historical
                  ? 'Показаны реальные этапы выбранного задания. Вернитесь к текущему запуску, чтобы наблюдать за работой.'
                  : 'Запустите исследование ниже: поиск → гипотеза → критика → проверка сервиса.'
          }}
        </p>
        <span v-if="online && current" class="live-provider"
          >{{ current.model || current.provider
          }}<template v-if="currentStrategy"> · {{ currentStrategy }}</template> ·
          {{ current.template ? serviceLabel(current.template) : 'Обработка заказа'
          }}<template v-if="current.is_demo"> · демонстрация</template></span
        >
      </div>
      <div class="live-timer">
        <strong>{{ online && current ? elapsed(current.created_at) : 'Нет данных' }}</strong
        ><span>{{
          online && current
            ? current.progress_chars
              ? `${current.progress_chars} симв. сформировано`
              : 'Ожидаем ответ инструмента'
            : 'Нет выполняемого вызова'
        }}</span>
        <div v-if="online && pending.length" class="signal-bars" aria-hidden="true">
          <i /><i /><i /><i /><i />
        </div>
      </div>
    </div>
    <div class="pipeline-heading">
      <span
        >{{ historical ? 'Выбранный запуск' : 'Текущий / последний запуск' }}
        <strong v-if="job">№ {{ job.id.slice(0, 8) }} · {{ labels[job.kind] }}</strong></span
      >
      <span>Движение означает выполняющийся запрос</span>
    </div>
    <div class="agent-stations" :class="{ 'order-stations': job?.kind === 'fulfill' }">
      <div
        v-for="(role, i) in shownRoles"
        :key="role.key"
        class="agent-station"
        :class="roleState(role.key)"
        :aria-current="roleState(role.key) === 'working' ? 'step' : undefined"
      >
        <span class="station-number">{{ String(i + 1).padStart(2, '0') }}</span>
        <span class="station-symbol" aria-hidden="true">{{ role.icon }}</span
        ><strong>{{ role.name }}</strong>
        <p>{{ role.purpose }}</p>
        <span class="station-state">{{ stageLabels[roleState(role.key)] }}</span>
        <span v-if="i < shownRoles.length - 1" class="station-connector" aria-hidden="true"
          ><i
        /></span>
      </div>
    </div>
    <div class="run-measurements" aria-label="Измерения выбранного запуска">
      <div>
        <span>Источники</span><strong>{{ sources.length || 'Нет данных' }}</strong
        ><small>Найдено поиском</small>
      </div>
      <div>
        <span>Токены на входе</span
        ><strong>{{ measuredCalls.length ? count(usage.input) : 'Нет данных' }}</strong
        ><small>Контекст и инструкции</small>
      </div>
      <div>
        <span>Токены на выходе</span
        ><strong>{{ measuredCalls.length ? count(usage.output) : 'Нет данных' }}</strong
        ><small>{{
          measuredCalls.length
            ? 'По полученным отчётам'
            : ['done', 'failed'].includes(job?.status)
              ? 'Нет измерений'
              : 'Появятся после ответа API'
        }}</small>
      </div>
      <div>
        <span>{{ cloudCalls ? 'Стоимость по ответу API' : 'Расходы API запуска' }}</span
        ><strong>{{ cloudCalls ? usd(usage.actualDollars) : rub(usage.cost) }}</strong
        ><small>{{
          cloudCalls
            ? 'С резервом: ' + usd(usage.dollars)
            : calls.some((c: any) => c.status !== 'done')
              ? 'Включая резервы вызовов'
              : 'По настроенному тарифу'
        }}</small>
      </div>
    </div>
    <p v-if="cloudCalls" class="muted small-text">
      По ответу API: {{ usd(usage.actualDollars) }}. Выход включает
      {{ count(usage.reasoning) }} токенов рассуждения; повторно они не прибавляются. Незавершённые
      и неопределённые запросы отдельно входят в сумму «С резервом».
    </p>
    <p class="muted small-text">
      После исследования откройте <NuxtLink to="/office?view=hypotheses">«Исследования»</NuxtLink>: там
      сохраняются идея и решение критика. Принятая идея выпускает версию сервиса в
      <NuxtLink to="/office/products">«Услугах»</NuxtLink>. Отклонённая остаётся в истории с причиной.
    </p>
    <div class="live-toolbar">
      <p>
        <strong>{{ online ? d.workload.running : 'Нет данных' }}</strong> задач в работе
        <span>·</span> {{ d.workload.queued }} в очереди<br /><small
          >Ручных запусков сегодня: {{ d.workload.manual_research_today }} · без суточного
          лимита</small
        >
      </p>
      <div class="research-controls">
        <label for="research-template">Направление исследования</label>
        <select id="research-template" v-model="researchTemplate" :disabled="researchDisabled">
          <option value="">Автоматический выбор</option>
          <option v-for="service in services" :key="service.id" :value="service.id">
            {{ service.label }}
          </option>
        </select>
        <button
          class="button primary small"
          :disabled="researchDisabled"
          @click="emit('research', researchTemplate || undefined)"
        >
          {{ researchActive ? 'Исследование выполняется…' : 'Проверить идею' }}
        </button>
      </div>
    </div>
    <details v-if="sources.length" class="live-sources">
      <summary>
        Найденные источники <span>{{ sources.length }} · доступны до завершения исследования</span>
      </summary>
      <ul>
        <li v-for="source in sources" :key="source.url">
          <a :href="source.url" target="_blank" rel="noopener noreferrer"
            >{{ source.title || source.url }} ↗</a
          >
        </li>
      </ul>
      <p>
        Модель получает фрагменты поисковой выдачи. Эти ссылки сами по себе не доказывают спрос.
      </p>
    </details>
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
                ><span>{{ call.template ? serviceLabel(call.template) : 'Заказ' }}</span
                ><time>{{
                  call.finished_at
                    ? elapsed(call.created_at, call.finished_at)
                    : online && call.status === 'pending' && job?.status === 'running'
                      ? elapsed(call.created_at)
                      : 'Нет данных'
                }}</time>
              </summary>
              <p>{{ call.task_label }}</p>
              <p v-if="call.input_tokens != null && call.output_tokens != null" class="call-usage">
                {{ count(call.input_tokens) }} токенов вход · {{ count(call.output_tokens) }} выход
                ·
                {{
                  call.provider === 'openai'
                    ? usd(call.charged_microusd)
                    : rub(call.charged_kopecks)
                }}
              </p>
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
          <p v-if="job.status === 'failed'">
            Запуск остановлен. Пройденные этапы сохранены в истории. После устранения причины
            запустите новое исследование.
          </p>
          <p v-if="!measuredCalls.length && ['done', 'failed'].includes(job.status)" class="muted">
            Для этого запуска нет измерений токенов. Это означает отсутствие данных, а не нулевой
            расход.
          </p>
          <p>
            {{ calls.filter((c: any) => c.status === 'done').length }} этапов завершено.
            {{ jobHypotheses.length }} гипотез сохранено.
          </p>
          <div v-if="draftIdea && !jobHypotheses.length" class="forming-idea">
            <span class="eyebrow">ГИПОТЕЗА СФОРМУЛИРОВАНА</span>
            <h4>{{ draftIdea.title }}</h4>
            <p>{{ draftIdea.hypothesis }}</p>
            <details>
              <summary>Возражение и способ проверки</summary>
              <p>{{ draftIdea.counterargument }}</p>
              <p>{{ draftIdea.experiment }}</p>
            </details>
            <p class="idea-verdict">
              {{
                critic
                  ? critic.resultSummary
                  : 'Ожидает отдельной проверки критиком. Решение о выпуске ещё не принято.'
              }}
            </p>
          </div>
          <p v-for="h in jobHypotheses" :key="h.id" class="outcome-idea">
            <strong>{{ h.title }}</strong
            ><span>{{ labels[h.status] }} · {{ h.is_demo ? 'демо' : 'живое исследование' }}</span>
          </p>
          <NuxtLink v-if="jobHypotheses.length" to="/office?view=hypotheses"
            >Открыть гипотезы и источники ↗</NuxtLink
          ><NuxtLink v-if="jobHypotheses.some((h: any) => h.status === 'accepted')" to="/office/products"
            >Посмотреть созданный продукт ↗</NuxtLink
          ></template
        >
        <p v-else>Первый результат появится после исследования.</p>
        <div class="next-run">
          <span>Следующий запуск по расписанию</span
          ><strong>{{
            !failure && d.nextResearchAt ? dateTime(d.nextResearchAt) : 'Не назначен'
          }}</strong>
          <p>
            {{ d.autonomy.reason }}
          </p>
        </div>
      </aside>
    </div>
  </section>
</template>
