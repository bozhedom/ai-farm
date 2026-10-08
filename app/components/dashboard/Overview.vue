<script setup lang="ts">
import type { Template } from '../../../core/policy'
const { state: d, failure } = useFarm()
const { services, serviceLabel, productLink, researchBlockedReason } = useServiceCatalog()
defineProps<{ busy: boolean }>()
const emit = defineEmits<{ control: [action: string] }>()
const researchTemplate = useState<Template | ''>('research-template', () => '')
const products = computed(() =>
  d.value.products.filter((p: any) => p.status === 'sandbox' && !p.needsRefresh),
)
const active = computed(() => d.value.jobs.find((j: any) => j.status === 'running'))
const currentCall = computed(() =>
  d.value.toolCalls.find((c: any) => c.job_id === active.value?.id && c.status === 'pending'),
)
const latestResearch = computed(() => d.value.jobs.find((j: any) => j.kind === 'research'))
const stopped = computed(() => d.value.state.mode !== 'running')
const title = computed(() => {
  if (failure.value) return 'Не удаётся обновить состояние'
  if (d.value.state.mode === 'emergency_stop') return 'Работа остановлена'
  if (d.value.state.mode === 'paused') return 'Новые задачи на паузе'
  if (!d.value.autonomy.workerAlive) return 'Обработчик не на связи'
  if (active.value)
    return active.value.kind === 'fulfill'
      ? 'Готовим текст заказа'
      : active.value.kind === 'evaluate'
        ? 'Подводим итоги недели'
        : 'Проверяем идею для сервиса'
  if (!d.value.state.research_enabled) return 'Пора пересмотреть идею'
  if (!d.value.state.provider_readiness?.model || !d.value.state.provider_readiness?.search)
    return 'Ждём модель или поиск'
  return d.value.autonomy.enabled ? 'Сервис работает самостоятельно' : 'Всё готово к запуску'
})
const description = computed(() => {
  if (failure.value) return 'Показаны последние полученные данные. Проверьте соединение.'
  if (currentCall.value) return currentCall.value.task_label
  if (active.value) return 'Результат сохранится здесь. Страницу можно закрыть.'
  if (d.value.state.mode === 'emergency_stop')
    return 'Генерация приостановлена. Заказы и результаты сохранены.'
  if (d.value.state.mode === 'paused')
    return 'Исследования и новые заказы приостановлены. Принятые заказы продолжают выполняться.'
  return d.value.autonomy.reason
})
const steps = computed(() => [
  {
    title: 'Находит идею',
    text: 'Ищет задачи покупателей и существующие предложения.',
    count: `Исследований: ${d.value.hypotheses.length}${d.value.hypotheses.length === 30 ? '+' : ''}`,
    to: '/office?view=hypotheses',
  },
  {
    title: 'Проверяет и собирает',
    text: 'Оценивает идею, создаёт услугу и проверяет пример текста.',
    count: `Готово услуг: ${products.value.length} из ${d.value.config.maxProducts}`,
    to: '/office/products',
  },
  {
    title: 'Выполняет заказ',
    text: 'Берёт материал, готовит текст и проверяет его перед выдачей.',
    count: `Тестовых выдач: ${d.value.orderStats.delivered}`,
    to: '/office?view=orders',
  },
  {
    title: 'Подводит итоги',
    text: 'Раз в неделю сравнивает результаты. Без продаж ждёт данных.',
    count: d.value.evaluations[0]
      ? labels[d.value.evaluations[0].decision]
      : 'Ожидает первой оценки',
    to: '/office?view=strategies',
  },
])
</script>

<template>
  <section class="work-card" aria-label="Текущая работа">
    <div class="work-copy">
      <span class="eyebrow">СЕЙЧАС</span>
      <h2>
        <span
          class="dot"
          :class="!failure && !stopped && d.autonomy.workerAlive ? 'green' : 'amber'"
        />{{ title }}
      </h2>
      <p>{{ description }}</p>
      <p v-if="!failure && !stopped && d.autonomy.nextAt && !active" class="muted small-text">
        Следующее исследование: {{ dateTime(d.autonomy.nextAt) }} по вашему времени.
      </p>
      <div class="work-actions">
        <button
          v-if="stopped"
          class="button primary"
          :disabled="busy || !!failure"
          @click="emit('control', 'running')"
        >
          Продолжить работу
        </button>
        <NuxtLink
          v-else-if="active || d.autonomy.activeRun"
          class="button primary"
          :to="active?.kind === 'fulfill' ? '/office?view=orders' : '/office?view=hypotheses'"
          >Посмотреть ход работы</NuxtLink
        >
        <button
          v-else-if="!d.state.research_enabled"
          class="button primary"
          :disabled="busy || !!failure"
          @click="emit('control', 'restart_research')"
        >
          Начать новый эксперимент
        </button>
        <template v-else>
          <label class="sr-only" for="home-template">Направление исследования</label>
          <select id="home-template" v-model="researchTemplate" :disabled="busy || !!failure">
            <option value="">Выбрать идею автоматически</option>
            <option v-for="service in services" :key="service.id" :value="service.id">
              {{ service.label }}
            </option>
          </select>
          <button
            class="button primary"
            :disabled="busy || !!researchBlockedReason"
            @click="emit('control', 'research')"
          >
            {{ busy ? 'Запускаем…' : 'Проверить идею' }}
          </button>
        </template>
        <button
          v-if="!stopped"
          class="button secondary"
          :disabled="busy || !!failure"
          @click="emit('control', 'paused')"
        >
          Пауза
        </button>
      </div>
      <p v-if="!stopped && researchBlockedReason && !active" class="muted small-text">
        {{ researchBlockedReason }}
      </p>
    </div>
    <div class="schedule-box">
      <strong>Автозапуск {{ d.autonomy.enabled ? 'включён' : 'выключен' }}</strong>
      <p>
        {{
          d.state.research_scope === 'all'
            ? 'Все направления раз в сутки, последовательно.'
            : 'Одно направление в день, по очереди.'
        }}
        Заказы выполняются по мере оплаты.
      </p>
      <button
        class="quiet"
        :disabled="busy || !!failure || !d.autonomy.allowed"
        @click="emit('control', d.autonomy.enabled ? 'schedule_off' : 'schedule_on')"
      >
        {{ d.autonomy.enabled ? 'Выключить автозапуск' : 'Включить автозапуск' }}
      </button>
      <p v-if="!d.autonomy.allowed" class="small-text">
        Разрешите автозапуск в настройках сервера.
      </p>
    </div>
  </section>

  <section class="panel portfolio-summary">
    <div>
      <h2>{{ services.length }} направлений, один рабочий цикл</h2>
      <p>
        Исследуйте весь набор задач: для каждой сохранится идея, решение критика и результат
        проверки.
      </p>
    </div>
    <NuxtLink class="button secondary" to="/office?view=directions">{{
      d.researchCampaign?.status === 'running' ? 'Прогресс всех направлений' : 'Выбрать направления'
    }}</NuxtLink>
  </section>

  <div
    v-if="latestResearch?.status === 'failed' && !d.autonomy.activeRun"
    class="notice"
    role="status"
  >
    Последнее исследование остановлено.
    {{
      latestResearch.error_code === 'SEARCH_INSUFFICIENT_SOURCES'
        ? 'Поиск не нашёл достаточно независимых источников. Можно повторить позже.'
        : 'Причина сохранена в истории запуска.'
    }}
    <NuxtLink to="/office?view=hypotheses">Посмотреть ход исследования</NuxtLink>
  </div>
  <div v-if="d.autonomy.reviewOrders" class="notice error" role="status">
    Заказы для проверки: {{ d.autonomy.reviewOrders }}.
    <NuxtLink to="/office?view=orders">Открыть заказы</NuxtLink>
  </div>
  <section class="cycle-strip" aria-label="Как работает сервис">
    <NuxtLink v-for="(step, i) in steps" :key="step.title" :to="step.to" class="cycle-item">
      <span class="cycle-number">{{ i + 1 }}</span>
      <h3>{{ step.title }}</h3>
      <p>{{ step.text }}</p>
      <strong
        >{{ step.count }}
        <svg
          class="link-icon"
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <path d="M7 17 17 7M8 7h9v9" /></svg
      ></strong>
    </NuxtLink>
  </section>

  <div class="overview-columns">
    <section class="panel ready-services">
      <div class="section-heading">
        <h2>Что уже можно попробовать</h2>
        <NuxtLink to="/office/products">Все услуги</NuxtLink>
      </div>
      <div v-if="!products.length" class="empty">
        Пока нет готовых услуг. Запустите проверку идеи. Если она пройдёт проверку, здесь появится
        форма заказа.
      </div>
      <NuxtLink
        v-for="product in products"
        :key="product.id"
        :to="productLink(product.id)"
        class="ready-service"
      >
        <span class="service-symbol" aria-hidden="true">{{
          serviceLabel(product.template).slice(0, 1)
        }}</span>
        <div>
          <strong>{{ serviceLabel(product.template) }}</strong>
          <p>
            {{ product.delivery }}
          </p>
          <small
            >{{ product.is_demo ? 'Демо' : 'Проверен на примере' }}, версия
            {{ product.version }}</small
          >
        </div>
        <svg
          class="link-icon"
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <path d="M7 17 17 7M8 7h9v9" />
        </svg>
      </NuxtLink>
      <p v-if="products.length" class="muted small-text">
        Откройте услугу, подставьте пример и подтвердите тестовую оплату. Готовый текст можно
        скачать.
      </p>
    </section>
    <section class="panel money-panel">
      <div class="section-heading">
        <h2>Деньги и результат</h2>
        <NuxtLink to="/office?view=settings">Лимиты</NuxtLink>
      </div>
      <dl class="money-list">
        <div>
          <dt>Расходы API за месяц</dt>
          <dd>{{ rub(d.budget.monthSpent) }}</dd>
        </div>
        <div>
          <dt>Реальная выручка</dt>
          <dd>{{ rub(d.realRevenueKopecks) }}</dd>
        </div>
        <div>
          <dt>Выдано тестовых заказов</dt>
          <dd>{{ d.orderStats.delivered }}</dd>
        </div>
      </dl>
      <div class="revenue-note">
        <strong>Откуда может появиться доход</strong>
        <p>
          Покупатель платит за полезный текст. Сначала нужно проверить качество, найти аудиторию и
          подключить обычную оплату.
        </p>
        <p>
          Сейчас доступен закрытый тест: сервис исследует идеи и выполняет заказы. Клиентов он не
          приводит, реальные платежи не принимает. Смена модели эти задачи не решает.
        </p>
      </div>
    </section>
  </div>
</template>
