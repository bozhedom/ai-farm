<script setup lang="ts">
import type { WalletClassification, WalletDeposit } from '../../../core/contracts/wallet'
import { officeApi, useOfficeAction } from '~/composables/office/actions'
import { when } from '~/composables/office/format'
import { classificationBadge, depositStatusBadge, exactAmount } from '~/composables/office/income'

/**
 * Deposits to the Bybit account. The owner marks each successful one as income (a client paid)
 * or not income (own transfer); only "income" counts as real money.
 */
const props = defineProps<{ deposits: WalletDeposit[]; limit?: number }>()
const shown = computed(() => props.deposits.slice(0, props.limit ?? props.deposits.length))
const { busy, run } = useOfficeAction()
const words: Record<WalletClassification, string> = {
  income: 'Отмечено: доход',
  not_income: 'Отмечено: не доход',
  unclassified: 'Отметка снята',
}
function mark(d: WalletDeposit, classification: WalletClassification) {
  const next = d.classification === classification ? 'unclassified' : classification
  return run(`deposit:${d.id}`, () => officeApi.classifyDeposit(d.id, next), words[next])
}
const shortTx = (tx: string) => (tx.length > 16 ? `${tx.slice(0, 8)}…${tx.slice(-6)}` : tx)
</script>
<template>
  <ul v-if="shown.length" class="deposits">
    <li v-for="d in shown" :key="d.id" :class="`is-${d.status}`">
      <div class="deposit-main">
        <b class="mono">{{ exactAmount(d.amount) }} {{ d.coin }}</b>
        <span class="deposit-meta">
          {{ d.source === 'internal' ? 'Перевод внутри Bybit' : d.chain || 'Блокчейн'
          }}<template v-if="d.from"> · от {{ d.from }}</template
          ><template v-if="d.txId"> · {{ shortTx(d.txId) }}</template>
        </span>
        <span class="deposit-meta">{{ when(d.successAt || d.firstSeenAt) }}</span>
      </div>
      <div class="deposit-side">
        <OfficeBadge v-if="d.status !== 'success'" :badge="depositStatusBadge[d.status]" />
        <template v-else>
          <OfficeBadge
            v-if="d.classification === 'unclassified'"
            :badge="classificationBadge.unclassified"
          />
          <div class="seg" role="group" :aria-label="`Отметка поступления ${d.amount} ${d.coin}`">
            <button
              type="button"
              class="btn btn-sm"
              :class="d.classification === 'income' ? 'btn-primary' : 'btn-ghost'"
              :aria-pressed="d.classification === 'income'"
              :disabled="!!busy"
              @click="mark(d, 'income')"
            >
              Доход
            </button>
            <button
              type="button"
              class="btn btn-sm"
              :class="d.classification === 'not_income' ? 'btn-primary' : 'btn-ghost'"
              :aria-pressed="d.classification === 'not_income'"
              :disabled="!!busy"
              @click="mark(d, 'not_income')"
            >
              Не доход
            </button>
          </div>
        </template>
      </div>
    </li>
  </ul>
  <p v-else class="small muted">Поступлений за последние 30 дней не найдено.</p>
</template>
<style scoped>
.deposits {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
}
.deposits li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--s-3) var(--s-4);
  padding: var(--s-3) 0;
  border-bottom: 1px solid var(--line);
  flex-wrap: wrap;
}
.deposits li:last-child {
  border-bottom: 0;
}
.deposit-main {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.deposit-main b {
  font-size: var(--text-md);
}
.is-failed .deposit-main b {
  color: var(--muted);
  text-decoration: line-through;
}
.deposit-meta {
  font-size: var(--text-sm);
  color: var(--muted);
  overflow-wrap: anywhere;
}
.deposit-side {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.seg {
  display: inline-flex;
  gap: 6px;
}
</style>
