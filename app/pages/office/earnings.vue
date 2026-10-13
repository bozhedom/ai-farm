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
        ? 'Расписание выключено. Начатый снимок может завершиться.'
        : action === 'enable'
          ? 'Мониторинг включён. Первый снимок появится после прохода обработчика.'
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
    <a class="t-skip" href="#earnings-main">К содержимому</a>
    <header class="trading-header">
      <NuxtLink class="trading-brand" to="/office/trading"
        >Ферма<span>кабинет владельца</span></NuxtLink
      >
      <nav class="header-actions" aria-label="Основные разделы">
        <NuxtLink class="t-link" to="/office/trading">Мои биржи</NuxtLink>
        <NuxtLink class="t-link" to="/office/products">Услуги</NuxtLink>
      </nav>
    </header>
    <main id="earnings-main" class="trading-main">
      <div class="page-heading">
        <div>
          <h1>Направления</h1>
          <p class="t-muted">Что можно проверить сейчас и что нужно для настоящего запуска.</p>
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
          <div class="e-readiness">
            <div>
              <h3>Уже в приложении</h3>
              <p>{{ track.available }}</p>
            </div>
            <div>
              <h3>До реального запуска</h3>
              <p>{{ track.remaining }}</p>
            </div>
          </div>
          <p class="e-assessment">{{ track.assessment }}</p>
          <div v-if="['spot', 'bots'].includes(track.id)" class="e-actions">
            <NuxtLink to="/office/trading" class="t-button t-primary">Открыть торговлю</NuxtLink>
            <p v-if="track.id === 'bots'" class="t-muted">
              Выберите биржу, затем «Стратегии» и набор «Сетка и DCA» в тренировке.
            </p>
          </div>
          <section v-if="monitored" class="e-monitor">
            <div class="section-heading">
              <div>
                <h3>Открытые данные</h3>
                <p class="t-muted">
                  Наблюдение без сделок и переводов. Обновление раз в
                  {{ data?.monitor.intervalMinutes || 15 }} минут.
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
                  {{ data.monitor.enabled ? 'Выключить расписание' : 'Включить мониторинг' }}
                </button>
                <button class="t-link" :disabled="busyMonitor" @click="control('refresh')">
                  {{
                    data.monitor.running
                      ? 'Получаем данные…'
                      : data.monitor.pending
                        ? 'Ждём обработчик…'
                        : 'Обновить снимок'
                  }}
                </button>
              </div>
              <p v-if="!data.monitor.workerAlive" class="t-notice t-warning">
                Обработчик сейчас не отвечает. Запрос сохранится, но для обновления нужно запустить
                worker.
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
                  Снимок {{ shortTime(data.arbitrage.fetchedAt) }}. Доступны
                  {{ data.arbitrage.sources.filter((s) => s.status === 'ok').length }} из 4 бирж.
                  Сопоставлено {{ data.arbitrage.pairsCompared }} пар.
                </p>
                <p
                  v-if="Date.parse(data.arbitrage.expiresAt) <= Date.now()"
                  class="t-notice t-warning"
                >
                  Цены этого снимка устарели. Это история наблюдения, не предложение сделки.
                </p>
                <p class="t-muted">
                  В расчёте на каждой стороне: комиссия {{ pct(data.arbitrage.feeBpsPerLeg) }} и
                  проскальзывание {{ pct(data.arbitrage.slippageBpsPerLeg) }}. Фактические тарифы,
                  глубина и идентичность токенов ещё не проверены. Переводы и ребалансировка не
                  учтены.
                </p>
                <div v-if="data.arbitrage.items.length" class="e-table-wrap">
                  <table class="e-table">
                    <caption>
                      Лучшие наблюдаемые разницы цен. Исполнение не подключено.
                    </caption>
                    <thead>
                      <tr>
                        <th>Монета</th>
                        <th>Купить / продать</th>
                        <th>Разница</th>
                        <th>После допущений</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="item in data.arbitrage.items" :key="item.symbol">
                        <th>{{ item.symbol }}</th>
                        <td>
                          {{ exchangeCatalog[item.buyExchange].name }} /
                          {{ exchangeCatalog[item.sellExchange].name }}
                        </td>
                        <td>{{ pct(item.grossBps) }}</td>
                        <td :class="item.estimatedNetBps > 0 ? 't-positive' : 't-muted'">
                          {{ pct(item.estimatedNetBps) }}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p v-else class="t-empty">В этом снимке нет сопоставимых свежих пар.</p>
              </template>
              <EarningsFeeds v-else-if="feeds.length" :feeds="feeds" />
              <p v-else class="t-empty">
                Снимков пока нет. Включите мониторинг или запросите одно обновление.
              </p>
            </template>
            <p v-else class="t-notice t-warning">
              Не удалось загрузить состояние.
              <button class="t-link" @click="refresh">Повторить</button>
            </p>
          </section>
          <EarningsServices v-if="['services', 'business'].includes(track.id)" />
          <section class="e-requirements">
            <h3>Что нужно от заказчика</h3>
            <ul>
              <li v-for="item in track.needs" :key="item">{{ item }}</li>
            </ul>
            <p class="e-caption">
              Доступы настраиваются локально или на сервере. Ключи и seed-фразы в переписку не
              отправляются.
            </p>
          </section>
          <a
            :href="track.source.url"
            :target="track.source.url.startsWith('https:') ? '_blank' : undefined"
            rel="noopener noreferrer"
            class="t-link"
            >{{ track.source.title }}<OfficeIcon name="external"
          /></a>
        </article>
      </div>
    </main>
  </div>
</template>
<style src="../../assets/trading.css"></style>
<style src="../../assets/earnings.css"></style>
