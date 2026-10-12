<script setup lang="ts">
import type { TradingView } from '../../../core/contracts/trading'
import { orderStatus, shortTime, tradingReason, usdt } from '~/utils/trading'
const props = defineProps<{ view: TradingView; disabled: boolean }>()
defineEmits<{ resolve: [] }>()
function exportOrders() {
  const v = props.view
  const rows = [
    [
      'time',
      'mode',
      'exchange',
      'client_id',
      'symbol',
      'side',
      'status',
      'filled_qty',
      'quote_usdt',
      'fee_base',
      'fee_usdt',
    ],
    ...v.orders.map((o) => [
      o.createdAt,
      v.mode,
      v.exchange,
      o.clientId,
      o.symbol,
      o.side,
      o.status,
      o.filledQty,
      o.quote,
      o.feeBase,
      o.feeQuote,
    ]),
  ]
  const blob = new Blob(
    [
      '\uFEFF' +
        rows.map((r) => r.map((s) => '"' + s.replaceAll('"', '""') + '"').join(',')).join('\r\n'),
    ],
    { type: 'text/csv;charset=utf-8' },
  )
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `ai-farm-${v.exchange}-${v.mode}-orders.csv`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
</script>
<template>
  <section class="t-stack">
    <div v-if="view.unresolvedClientId" class="t-notice t-warning">
      <h3>Нужно проверить заявку на бирже</h3>
      <p>
        Ответ на отправку не получен. Бот ищет заявку и не отправляет её повторно. Проверьте историю
        биржи по ID:
      </p>
      <code class="record-id">{{ view.unresolvedClientId }}</code>
      <p>
        Подтверждайте отсутствие только после проверки. Для этого торговля должна быть остановлена.
      </p>
      <button
        class="t-button"
        :disabled="disabled || view.status !== 'stopped'"
        @click="$emit('resolve')"
      >
        Подтвердить отсутствие на бирже
      </button>
    </div>
    <div class="section-heading">
      <div>
        <h2>Покупки и продажи</h2>
        <p class="t-muted">Последние 50 заявок. Суммы показывают фактически исполненную часть.</p>
      </div>
      <button class="t-button" :disabled="!view.orders.length" @click="exportOrders">
        <OfficeIcon name="download" />Скачать CSV
      </button>
    </div>
    <div v-if="!view.orders.length" class="t-empty">
      <h3>Сделок пока нет</h3>
      <p>
        {{
          view.status === 'running'
            ? 'Бот ждёт подходящую цену. Как только появится первая заявка, она будет здесь.'
            : 'После запуска здесь появятся покупки и продажи.'
        }}
      </p>
    </div>
    <ol v-else class="order-list">
      <li v-for="o in view.orders" :key="o.id">
        <div class="order-heading">
          <span
            class="order-symbol"
            :class="o.side === 'buy' ? 't-positive' : 't-negative'"
            aria-hidden="true"
            ><OfficeIcon name="back" :class="o.side === 'buy' ? 'order-buy' : 'order-sell'"
          /></span>
          <div>
            <strong
              >{{ o.side === 'buy' ? 'Покупка' : 'Продажа' }} {{ o.symbol.split('-')[0] }}</strong
            ><small>{{ shortTime(o.createdAt) }} · {{ o.agentName }}</small>
          </div>
          <div class="order-value">
            <strong>{{ usdt(o.quote, 2) }} USDT</strong><small>{{ orderStatus[o.status] }}</small>
          </div>
        </div>
        <details class="order-details">
          <summary>Подробнее о заявке</summary>
          <p>{{ tradingReason(o.reason) }}</p>
          <dl class="t-facts">
            <div>
              <dt>Куплено или продано</dt>
              <dd>{{ o.filledQty }} из {{ o.qty }} {{ o.symbol.split('-')[0] }}</dd>
            </div>
            <div>
              <dt>Предельная цена</dt>
              <dd>{{ o.price }} USDT</dd>
            </div>
            <div>
              <dt>Комиссия в монете</dt>
              <dd>{{ o.feeBase }} {{ o.symbol.split('-')[0] }}</dd>
            </div>
            <div>
              <dt>Комиссия в USDT</dt>
              <dd>{{ o.feeQuote }}</dd>
            </div>
          </dl>
          <p class="t-muted">
            Отменённая заявка могла исполниться частично. Минус в комиссии означает списание.
          </p>
          <p class="record-id">ID: {{ o.clientId }}</p>
        </details>
      </li>
    </ol>
    <details class="t-details">
      <summary>
        Технический журнал <span>{{ view.events.length }} событий</span>
      </summary>
      <div class="t-details-body">
        <ol v-if="view.events.length" class="event-list">
          <li v-for="e in view.events" :key="e.id">
            <time>{{ shortTime(e.at) }}</time
            ><span>{{ tradingReason(e.reason) }}</span>
          </li>
        </ol>
        <p v-else class="t-muted">Здесь появятся запуски, остановки и результаты проверок.</p>
      </div>
    </details>
  </section>
</template>
