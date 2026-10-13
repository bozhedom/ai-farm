<script setup lang="ts">
import type { OpportunityFeed } from '../../../core/opportunities/types'
import { shortTime } from '~/utils/trading'

const props = defineProps<{ feeds: OpportunityFeed[] }>()
const selectedFeed = ref('')
const visibleFeeds = computed(() => {
  const feed = props.feeds.find((f) => f.id === selectedFeed.value) || props.feeds[0]
  return feed ? [feed] : []
})
const expanded = ref<string[]>([])
const number = (v: string | null, digits = 2) =>
  v === null ? 'Нет данных' : Number(v).toLocaleString('ru-RU', { maximumFractionDigits: digits })
</script>
<template>
  <div class="e-feeds">
    <div v-if="feeds.length > 1" class="e-feed-switch" role="group" aria-label="Источник данных">
      <button
        v-for="feed in feeds"
        :key="feed.id"
        class="t-button"
        :class="{ 'e-selected': visibleFeeds[0]?.id === feed.id }"
        :aria-pressed="visibleFeeds[0]?.id === feed.id"
        @click="selectedFeed = feed.id"
      >
        {{ feed.title }}
      </button>
    </div>
    <section v-for="feed in visibleFeeds" :key="feed.id" class="e-feed">
      <div class="section-heading">
        <h3>{{ feed.title }}</h3>
        <span class="t-muted">Получено {{ shortTime(feed.fetchedAt) }}</span>
      </div>
      <p v-if="feed.status === 'unavailable'" class="t-notice t-warning" role="status">
        Источник не ответил или вернул неполные данные.
        {{
          feed.items.length
            ? 'Показываем доступные данные. Проверьте время обновления.'
            : 'Повторим при следующем обновлении.'
        }}
      </p>
      <p v-else-if="Date.parse(feed.expiresAt) <= Date.now()" class="t-notice t-warning">
        Данные устарели. Обновите их перед сравнением.
      </p>
      <p v-if="!feed.items.length && feed.status !== 'unavailable'" class="t-empty">
        Подходящих записей пока нет.
      </p>
      <ul v-else class="e-observations">
        <li
          v-for="item in expanded.includes(feed.id) ? feed.items : feed.items.slice(0, 5)"
          :key="item.id"
        >
          <template v-if="item.kind === 'funding'">
            <div>
              <a :href="item.url" target="_blank" rel="noopener noreferrer">{{ item.symbol }}</a>
              <small>Ближайшее начисление {{ shortTime(item.nextFundingAt) }}</small>
            </div>
            <div class="e-value">
              {{ number(item.ratePercent, 8) }}%<small>{{
                item.intervalHours ? `за ${item.intervalHours} ч.` : 'интервал не указан'
              }}</small>
            </div>
          </template>
          <template v-else-if="item.kind === 'prediction'">
            <div class="e-market-title">
              <a :href="item.url" target="_blank" rel="noopener noreferrer">{{ item.title }}</a>
              <small v-if="item.volume24hContracts !== null"
                >Оборот за сутки: {{ number(item.volume24hContracts, 2) }} контрактов</small
              >
              <small v-else>Оборот за сутки: {{ number(item.volume24hUsd, 0) }} USD</small>
              <small v-if="item.closesAt">Срок события {{ shortTime(item.closesAt) }}</small>
            </div>
            <div class="e-outcomes">
              <span v-for="outcome in item.outcomes" :key="outcome.name"
                >{{ outcome.name }} <b>{{ number(outcome.price, 4) }}</b></span
              >
              <small
                >{{ item.priceKind === 'ask' ? 'Цена предложения' : 'Ориентировочная цена' }} за
                контракт, от 0 до 1</small
              >
            </div>
          </template>
          <template v-else>
            <div>
              <a :href="item.url" target="_blank" rel="noopener noreferrer"
                >{{ item.project }} · {{ item.symbol }}</a
              >
              <small>{{ item.chain }} · TVL {{ number(item.tvlUsd, 0) }} USD</small>
              <small v-if="item.observedAt === null">Источник не сообщает время расчёта</small>
            </div>
            <div class="e-value">
              {{ number(item.apyPercent) }}%<small>оценка APY</small>
              <small v-if="item.rewardApyPercent !== null"
                >из них награды {{ number(item.rewardApyPercent) }}%</small
              >
            </div>
          </template>
        </li>
      </ul>
      <button
        v-if="feed.items.length > 5"
        class="t-link"
        @click="
          expanded = expanded.includes(feed.id)
            ? expanded.filter((v) => v !== feed.id)
            : [...expanded, feed.id]
        "
      >
        {{ expanded.includes(feed.id) ? 'Свернуть' : `Показать все (${feed.items.length})` }}
      </button>
      <p class="e-caption">
        {{
          feed.kind === 'funding'
            ? 'Положительный фандинг обычно платят владельцы длинных позиций коротким; знак и условия могут измениться.'
            : feed.kind === 'yield'
              ? 'APY показывает оценку годовой доходности по данным источника и может измениться.'
              : 'Цены исходов получены с площадки.'
        }}
      </p>
    </section>
  </div>
</template>
