<script setup lang="ts">
import type { Template } from '../../../core/policy'

const { state: d, failure } = useFarm()
const { services, serviceLabel, productLink, researchBlockedReason } = useServiceCatalog()
defineProps<{ busy: boolean }>()
const emit = defineEmits<{ control: [action: string, template?: Template] }>()
const category = ref('')
const query = ref('')
function resetFilters() {
  query.value = ''
  category.value = ''
}
const categories = computed(() => [...new Set(services.value.map((item) => item.category))])
const filtered = computed(() =>
  services.value.filter(
    (item) =>
      (!category.value || item.category === category.value) &&
      `${item.label} ${item.audience} ${item.delivery}`
        .toLocaleLowerCase('ru')
        .includes(query.value.trim().toLocaleLowerCase('ru')),
  ),
)
const campaign = computed(() => d.value.researchCampaign)
const processed = computed(() =>
  campaign.value ? campaign.value.completed + campaign.value.failed + campaign.value.cancelled : 0,
)
const productFor = (template: string) =>
  d.value.products.find(
    (p: any) => p.template === template && p.status === 'sandbox' && !p.needsRefresh,
  )
const itemFor = (template: string) =>
  campaign.value?.items.find((item: any) => item.template === template)
function itemLabel(item: any) {
  if (!item) return 'Ещё не исследовано'
  if (item.errorCode === 'RESEARCH_CAMPAIGN_CANCELLED') return 'Отменено владельцем'
  if (item.errorCode === 'RESEARCH_DAILY_BUDGET_WAIT' && item.status === 'queued')
    return 'Ждёт дневного бюджета'
  if (item.status === 'done') {
    if (item.productId) return 'Услуга готова'
    if (item.hypothesisStatus === 'rejected') return 'Идея отклонена'
    if (item.hypothesisStatus === 'backlog') return 'Идея в резерве'
    return 'Исследовано'
  }
  return labels[item.status] || item.status
}
</script>

<template>
  <section class="panel portfolio-launch">
    <div>
      <span class="eyebrow">ПОРТФЕЛЬ ТЕКСТОВЫХ УСЛУГ</span>
      <h2>{{ services.length }} направлений для проверки спроса</h2>
      <p>
        Запустите весь набор или выберите задачу. Система найдёт источники, проверит идею и
        подготовит услугу, если она пройдёт проверку.
      </p>
      <p class="muted small-text">
        Направления выполняются по очереди, оплаченные тестовые заказы имеют приоритет. Один общий
        бюджет, до {{ d.config.maxProducts }} услуг. Проверка может отклонить идею; доход и выпуск
        всех услуг не гарантированы.
      </p>
    </div>
    <div class="portfolio-actions">
      <button
        v-if="d.state.mode !== 'running'"
        class="button primary"
        :disabled="busy || !!failure"
        @click="emit('control', 'running')"
      >
        Продолжить работу
      </button>
      <button
        v-else
        class="button primary"
        :disabled="busy || !!researchBlockedReason"
        @click="emit('control', 'research_all')"
      >
        {{ busy ? 'Запускаем…' : 'Исследовать все направления' }}
      </button>
      <NuxtLink to="/office?view=guide">Как проверить результат →</NuxtLink>
    </div>
    <p v-if="researchBlockedReason" class="muted small-text portfolio-hint" role="status">
      {{ researchBlockedReason }}
      <NuxtLink
        v-if="
          !d.autonomy.workerAlive ||
          d.state.provider_readiness?.model === false ||
          d.state.provider_readiness?.search === false
        "
        to="/office?view=settings"
        >Открыть настройки</NuxtLink
      >
    </p>
  </section>

  <section v-if="campaign" class="panel campaign-panel" aria-labelledby="campaign-title">
    <div class="section-heading">
      <div>
        <span class="eyebrow"
          >{{ campaign.source === 'scheduled' ? 'ПО РАСПИСАНИЮ' : 'ЗАПУЩЕНО ВЛАДЕЛЬЦЕМ' }} ·
          {{ dateTime(campaign.createdAt) }}</span
        >
        <h2 id="campaign-title">
          {{
            campaign.status === 'running'
              ? 'Проверяем направления'
              : campaign.status === 'cancelled'
                ? 'Исследование остановлено владельцем'
                : 'Исследование направлений завершено'
          }}
        </h2>
      </div>
      <strong>{{ processed }} / {{ campaign.total }}</strong>
    </div>
    <progress :value="processed" :max="campaign.total" aria-label="Обработано направлений" />
    <p class="muted small-text" aria-live="polite">
      Завершено: {{ campaign.completed }} · Ошибок: {{ campaign.failed }} · В работе:
      {{ campaign.running }} · Ожидают: {{ campaign.pending
      }}<template v-if="campaign.cancelled"> · Отменено: {{ campaign.cancelled }}</template>
    </p>
    <p class="muted small-text">
      Завершённая проверка может закончиться отказом. Решения и причины сохранены в разделе
      «Исследования».
    </p>
    <div class="inline-actions">
      <NuxtLink to="/office?view=hypotheses">Ход работы и результаты →</NuxtLink>
      <button
        v-if="campaign.status === 'running'"
        class="quiet"
        :disabled="busy || !!failure"
        @click="emit('control', 'cancel_research_all')"
      >
        Отменить оставшиеся направления
      </button>
    </div>
  </section>

  <div class="catalog-filters">
    <div>
      <label for="direction-search">Поиск задачи или аудитории</label
      ><input
        id="direction-search"
        v-model="query"
        type="search"
        placeholder="Например, магазин или инструкция"
      />
    </div>
    <div>
      <label for="direction-category">Область</label
      ><select id="direction-category" v-model="category">
        <option value="">Все области</option>
        <option v-for="item in categories" :key="item">{{ item }}</option>
      </select>
    </div>
    <span class="muted small-text" role="status"
      >Найдено: {{ filtered.length }} из {{ services.length }}</span
    >
  </div>
  <div v-if="!filtered.length" class="panel empty">
    По этому запросу направлений нет.
    <button class="quiet" @click="resetFilters">Сбросить фильтры</button>
  </div>
  <div class="direction-grid">
    <article v-for="item in filtered" :key="item.id" class="panel direction-card">
      <div class="section-heading">
        <span class="eyebrow">{{ item.category }}</span
        ><span v-if="productFor(item.id) || itemFor(item.id)" class="tag">{{
          productFor(item.id) ? 'Есть готовая услуга' : itemLabel(itemFor(item.id))
        }}</span>
      </div>
      <h2>{{ item.label }}</h2>
      <p>{{ item.delivery }}</p>
      <dl class="direction-details">
        <div>
          <dt>Кому полезно</dt>
          <dd>{{ item.audience }}</dd>
        </div>
        <div>
          <dt>Где искать клиентов</dt>
          <dd>
            <ul>
              <li v-for="channel in item.channels" :key="channel">{{ channel }}</li>
            </ul>
          </dd>
        </div>
      </dl>
      <details class="direction-sample">
        <summary>Что нужно для заказа</summary>
        <p>{{ item.inputLabel }}</p>
        <blockquote>{{ item.example }}</blockquote>
      </details>
      <p
        v-if="
          itemFor(item.id)?.errorCode &&
          itemFor(item.id).errorCode !== 'RESEARCH_CAMPAIGN_CANCELLED'
        "
        class="error-text small-text"
      >
        {{ errorText({ data: { statusMessage: itemFor(item.id).errorCode } }) }}
      </p>
      <div class="direction-actions">
        <NuxtLink
          v-if="productFor(item.id)"
          class="button secondary small"
          :to="productLink(productFor(item.id).id)"
          >Попробовать услугу →</NuxtLink
        >
        <button
          :class="productFor(item.id) ? 'quiet' : 'button secondary small'"
          :disabled="busy || !!researchBlockedReason"
          :aria-label="'Исследовать: ' + serviceLabel(item.id)"
          @click="emit('control', 'research', item.id)"
        >
          {{
            itemFor(item.id)?.status === 'failed'
              ? 'Повторить исследование'
              : productFor(item.id)
                ? 'Исследовать заново'
                : 'Исследовать направление'
          }}
        </button>
      </div>
    </article>
  </div>
  <p class="muted small-text">
    Каналы — идеи для самостоятельной проверки. Автоматических публикаций, рассылок и продаж здесь
    нет. Используйте свои материалы и разрешённые площадкой способы размещения.
  </p>
</template>
