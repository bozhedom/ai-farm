<script setup lang="ts">
import type { EarningsView } from '../../../core/contracts/earnings'
import { earningTracks, type EarningTrackId } from '../../../core/earnings/catalog'
import { exchangeCatalog } from '../../../core/trading/catalog'
import { officeFetch, useOfficeResource } from '~/composables/office/resource'
import { shortTime, pct } from '~/utils/trading'

useHead({ title: 'Направления' })
const route = useRoute()
const track = computed(
  () => earningTracks.find((t) => t.id === route.query.track) || earningTracks[0]!,
)
const selected = computed({
  get: () => track.value.id,
  set: (id: EarningTrackId) => {
    void navigateTo({ path: '/office/earnings', query: { track: id } })
  },
})
const yieldTrack = ref<'funding' | 'defi'>('funding')
const { data, pending, status, refresh } = useOfficeResource<EarningsView>(
  () => 'earnings',
  () => officeFetch('/api/earnings'),
  { interval: 10_000 },
)
const monitored = computed(() => ['arbitrage', 'yield', 'prediction'].includes(track.value.id))
const feeds = computed(() =>
  (data.value?.report?.feeds || []).filter((f) =>
    track.value.id === 'prediction'
      ? f.kind === 'prediction'
      : track.value.id === 'yield' && f.kind !== 'prediction',
  ),
)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const busyMonitor = computed(
  () => busy.value || data.value?.monitor.running || data.value?.monitor.pending,
)
watch(selected, () => {
  error.value = ''
  notice.value = ''
})
async function control(action: 'enable' | 'pause' | 'refresh') {
  if (busy.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await officeFetch('/api/earnings/control', { method: 'POST', body: { action } })
    notice.value =
      action === 'pause'
        ? 'Автообновление выключено. Текущая загрузка завершится.'
        : action === 'enable'
          ? 'Автообновление включено. Загружаем данные.'
          : 'Обновление запрошено.'
    await refresh()
  } catch (e) {
    const code = (e as { data?: { statusMessage?: string } }).data?.statusMessage
    error.value =
      code === 'EARNINGS_REFRESH_COOLDOWN'
        ? 'Данные только что запрашивались. Следующее ручное обновление доступно через минуту.'
        : 'Не удалось сохранить действие. Проверьте соединение и повторите.'
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <div class="trading-workspace earnings-workspace">
    <div class="trading-main">
      <div class="page-heading">
        <div>
          <h1>Направления</h1>
          <p class="t-muted">Торговля, рыночные данные и заказы.</p>
        </div>
      </div>
      <p v-if="status.offline" class="t-notice t-warning" role="alert">
        Нет связи. Показываем последнее состояние.
      </p>
      <div class="e-layout">
        <nav class="e-navigation" aria-label="Направления работы">
          <NuxtLink
            v-for="item in earningTracks"
            :key="item.id"
            :to="{ path: '/office/earnings', query: { track: item.id } }"
            :aria-current="track.id === item.id ? 'page' : undefined"
            :class="{ selected: track.id === item.id }"
          >
            <span>{{ item.title }}</span
            ><small>{{ item.stage }}</small>
          </NuxtLink>
        </nav>
        <label class="e-mobile-select"
          >Направление<select v-model="selected" aria-label="Направление">
            <option v-for="item in earningTracks" :key="item.id" :value="item.id">
              {{ item.title }}
            </option>
          </select></label
        >
        <article class="e-detail">
          <header class="e-detail-heading">
            <span class="e-stage">{{ track.stage }}</span>
            <h2>{{ track.title }}</h2>
            <p>{{ track.summary }}</p>
          </header>
          <div v-if="['spot', 'bots'].includes(track.id)" class="e-actions">
            <NuxtLink to="/office/trading" class="t-button t-primary">Мои биржи</NuxtLink>
            <NuxtLink v-if="track.id === 'spot'" to="/office/manager" class="t-button"
              >Менеджер торговли</NuxtLink
            >
            <p v-if="track.id === 'bots'" class="t-muted">
              Откройте биржу в режиме «Тренировка», затем выберите «Стратегии» и набор «Сетка и
              DCA».
            </p>
          </div>
          <div v-if="track.id === 'business'" class="e-actions">
            <NuxtLink to="/office/products" class="t-button">Мои услуги</NuxtLink>
            <NuxtLink to="/storefront" class="t-link">Витрина</NuxtLink>
          </div>
          <template v-if="monitored">
            <div
              v-if="track.id === 'yield'"
              class="e-mode-tabs"
              role="group"
              aria-label="Вид вложения"
            >
              <button :aria-pressed="yieldTrack === 'funding'" @click="yieldTrack = 'funding'">
                Фандинг
              </button>
              <button :aria-pressed="yieldTrack === 'defi'" @click="yieldTrack = 'defi'">
                DeFi
              </button>
            </div>
            <EarningsExecution
              :key="track.id === 'yield' ? yieldTrack : track.id"
              :track="
                track.id === 'yield'
                  ? yieldTrack
                  : track.id === 'arbitrage'
                    ? 'arbitrage'
                    : 'prediction'
              "
            />
          </template>
          <details v-if="monitored" class="e-market-details">
            <summary>Обзор рынка</summary>
            <section class="e-monitor">
              <div class="section-heading">
                <div>
                  <h3>Обновление данных</h3>
                  <p class="t-muted">
                    Сравнение цен обновляется раз в
                    {{ data?.monitor.arbitrageIntervalMinutes || 3 }} мин; фандинг, DeFi и прогнозы
                    обновляются раз в {{ data?.monitor.intervalMinutes || 15 }} мин.
                  </p>
                </div>
              </div>
              <p v-if="pending" role="status">Проверяем мониторинг…</p>
              <template v-else-if="data">
                <div class="e-actions">
                  <button
                    class="t-button"
                    :disabled="busy"
                    @click="control(data.monitor.enabled ? 'pause' : 'enable')"
                  >
                    {{
                      data.monitor.enabled ? 'Выключить автообновление' : 'Включить автообновление'
                    }}
                  </button>
                  <button class="t-link" :disabled="busyMonitor" @click="control('refresh')">
                    {{
                      data.monitor.running
                        ? 'Получаем данные…'
                        : data.monitor.pending
                          ? 'Обновление в очереди…'
                          : 'Обновить сейчас'
                    }}
                  </button>
                </div>
                <p v-if="!data.monitor.workerAlive" class="t-notice t-warning">
                  Обновление временно недоступно. Запрос сохранён и выполнится после восстановления
                  связи.
                </p>
                <p v-if="data.monitor.enabled && data.monitor.nextAt" class="e-caption">
                  Следующее обновление {{ shortTime(data.monitor.nextAt) }}.
                </p>
                <p v-if="data.monitor.error" class="t-notice t-warning">
                  Не все источники обновились. Предыдущие данные могут быть устаревшими.
                </p>
                <p v-if="notice" class="t-notice" role="status">{{ notice }}</p>
                <p v-if="error" class="t-notice t-warning" role="alert">{{ error }}</p>
                <template v-if="track.id === 'arbitrage' && data.arbitrage">
                  <p class="e-caption">
                    Обновлено {{ shortTime(data.arbitrage.fetchedAt) }}. Доступны
                    {{ data.arbitrage.sources.filter((s) => s.status === 'ok').length }} из 4 бирж.
                    Сопоставлено {{ data.arbitrage.pairsCompared }} пар.
                  </p>
                  <p
                    v-if="Date.parse(data.arbitrage.expiresAt) <= Date.now()"
                    class="t-notice t-warning"
                  >
                    Цены устарели. Обновите данные перед сравнением.
                  </p>
                  <div v-if="data.arbitrage.items.length" class="e-table-wrap">
                    <table class="e-table">
                      <caption>
                        Разница цен по последним котировкам
                      </caption>
                      <thead>
                        <tr>
                          <th>Монета</th>
                          <th>Купить / продать</th>
                          <th>Разница</th>
                          <th>С учётом затрат</th>
                          <th>Стакан</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr
                          v-for="item in data.arbitrage.items"
                          :key="`${item.symbol}:${item.buyExchange}:${item.sellExchange}`"
                        >
                          <th>{{ item.symbol }}</th>
                          <td>
                            {{ exchangeCatalog[item.buyExchange].name }} /
                            {{ exchangeCatalog[item.sellExchange].name }}
                          </td>
                          <td>{{ pct(item.grossBps) }}</td>
                          <td :class="item.estimatedNetBps > 0 ? 't-positive' : 't-muted'">
                            {{ pct(item.estimatedNetBps) }}
                          </td>
                          <td class="t-muted">
                            {{
                              item.depthChecked
                                ? item.fillableNotional
                                  ? `до ${item.fillableNotional} USDT`
                                  : 'проверен'
                                : 'тикер'
                            }}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <p v-else class="t-empty">Нет свежих котировок для сравнения.</p>
                  <details class="t-details">
                    <summary>Как рассчитана разница</summary>
                    <div class="t-details-body">
                      <p>
                        Сначала сравниваются публичные тикеры (комиссия
                        {{ pct(data.arbitrage.feeBpsPerLeg) }} и проскальзывание
                        {{ pct(data.arbitrage.slippageBpsPerLeg) }} на ногу). Лучшие пары
                        дополнительно оцениваются по стакану на образец
                        {{ data.arbitrage.sampleNotional || '50' }} USDT. Переводы между биржами не
                        учитываются и не выполняются.
                      </p>
                      <p>
                        Расчёт ориентировочный: фактические тарифы аккаунта и совпадение токенов не
                        проверены. Положительная разница не означает доступную сделку.
                      </p>
                    </div>
                  </details>
                </template>
                <EarningsFeeds v-else-if="feeds.length" :feeds="feeds" />
                <p v-else class="t-empty">
                  Данных пока нет. Нажмите «Обновить сейчас» или включите автообновление.
                </p>
              </template>
              <p v-else class="t-notice t-warning">
                Не удалось загрузить состояние.
                <button class="t-link" @click="refresh">Повторить</button>
              </p>
            </section>
          </details>
          <EarningsServices v-if="['services', 'business'].includes(track.id)" />
        </article>
      </div>
    </div>
  </div>
</template>
<style src="../../assets/trading.css"></style>
<style src="../../assets/earnings.css"></style>
