<script setup lang="ts">
import type { PublicOrderView } from '../../../core/contracts/public'
import { publicErrorCode, publicWhen } from '~/utils/public-site'

type Sepolia = Extract<PublicOrderView['payment'], { mode: 'sepolia' }>
const props = defineProps<{ payment: Sepolia; token: string; expiresAt: string }>()
const emit = defineEmits<{ changed: [] }>()

const sepolia = {
  chainId: '0xaa36a7',
  chainName: 'Sepolia',
  nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'],
  blockExplorerUrls: ['https://sepolia.etherscan.io'],
}
const local = computed(() => props.payment.network === 'local')
const mounted = ref(false)
const hasWallet = ref(false)
onMounted(() => {
  mounted.value = true
  hasWallet.value = !!(window as any).ethereum
})

const walletState = ref<'idle' | 'busy'>('idle')
const walletStep = ref('')
const walletError = ref('')
const walletSent = ref('')

const payErrors: Record<string, string> = {
  WRONG_AMOUNT: 'Сумма этого перевода не совпадает со счётом.',
  WRONG_RECEIVER: 'Этот перевод ушёл на другой адрес.',
  ONLY_NATIVE_TRANSFER_ALLOWED: 'Нужен обычный перевод ETH, без токенов и контрактов.',
  TX_ALREADY_USED: 'Этот перевод уже привязан к другому заказу.',
  DUPLICATE_PAYMENT_OR_REQUEST: 'Этот перевод уже привязан к другому заказу.',
  ORDER_NOT_PAYABLE: 'Заказ сейчас не ждёт оплату.',
  RATE_LIMITED: 'Слишком много попыток. Подождите немного.',
  INVALID_INPUT: 'Номер транзакции выглядит иначе: 0x и 64 знака.',
}
async function sendHash(hash: string) {
  await $fetch(`/api/public/orders/${props.token}/pay`, {
    method: 'POST',
    body: { mode: 'sepolia', hash },
  })
  emit('changed')
}

async function payWithWallet() {
  walletError.value = ''
  const eth = (window as any).ethereum
  if (!eth) {
    walletError.value =
      'Кошелёк в браузере не найден. Переведите вручную по адресу ниже или отсканируйте QR-код.'
    return
  }
  walletState.value = 'busy'
  let hash = ''
  try {
    walletStep.value = 'Откройте кошелёк и разрешите доступ'
    const [from] = await eth.request({ method: 'eth_requestAccounts' })
    walletStep.value = 'Переключаем кошелёк на сеть Sepolia'
    try {
      await eth.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: sepolia.chainId }],
      })
    } catch (e: any) {
      const code = e?.code ?? e?.data?.originalError?.code
      if (code !== 4902) throw e
      await eth.request({ method: 'wallet_addEthereumChain', params: [sepolia] })
    }
    if (String(await eth.request({ method: 'eth_chainId' })).toLowerCase() !== sepolia.chainId)
      throw Object.assign(new Error('chain'), { code: 'CHAIN' })
    walletStep.value = 'Подтвердите перевод в кошельке'
    hash = await eth.request({
      method: 'eth_sendTransaction',
      params: [
        {
          from,
          to: props.payment.receiver,
          value: '0x' + BigInt(props.payment.amountWei).toString(16),
        },
      ],
    })
    walletSent.value = hash
    walletStep.value = 'Перевод отправлен, сообщаем магазину'
    await sendHash(hash)
  } catch (e: any) {
    if (hash) {
      // The transfer left the wallet; the server finds it by scanning blocks anyway.
      walletError.value = 'Перевод отправлен. Мы найдём его сами, подождите минуту.'
    } else if (e?.code === 4001) walletError.value = 'Вы отменили перевод в кошельке.'
    else if (e?.code === 'CHAIN')
      walletError.value = 'Переключите кошелёк на сеть Sepolia и попробуйте снова.'
    else
      walletError.value = 'Кошелёк не отправил перевод. Попробуйте ещё раз или переведите вручную.'
  } finally {
    walletState.value = 'idle'
    walletStep.value = ''
  }
}

const hashInput = ref('')
const hashError = ref('')
const hashBusy = ref(false)
async function submitHash() {
  hashError.value = ''
  const hash = hashInput.value.trim()
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    hashError.value = payErrors.INVALID_INPUT!
    return
  }
  hashBusy.value = true
  try {
    await sendHash(hash)
    hashInput.value = ''
  } catch (e) {
    const code = publicErrorCode(e)
    hashError.value =
      (code && payErrors[code]) || 'Не получилось проверить перевод. Попробуйте ещё раз.'
  } finally {
    hashBusy.value = false
  }
}

const waiting = computed(() => !props.payment.hash)
const progress = computed(() =>
  Math.round(
    (Math.min(props.payment.confirmations, props.payment.required) / props.payment.required) * 100,
  ),
)
</script>

<template>
  <div class="crypto">
    <div v-if="props.payment.hash" class="found">
      <div class="row between">
        <span class="strong">Подтверждения сети</span>
        <span class="mono"
          >{{ Math.min(props.payment.confirmations, props.payment.required) }} из
          {{ props.payment.required }}</span
        >
      </div>
      <div
        class="bar bar-lg"
        role="progressbar"
        :aria-valuenow="progress"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <i :style="{ width: progress + '%' }" />
      </div>
      <a
        v-if="props.payment.explorerUrl"
        :href="props.payment.explorerUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="small"
      >
        Посмотреть перевод в сети
      </a>
    </div>

    <template v-if="props.payment.canSubmit">
      <div v-if="waiting" class="wallet">
        <template v-if="!local">
          <button
            type="button"
            class="btn btn-primary btn-lg btn-block"
            :disabled="walletState === 'busy'"
            @click="payWithWallet"
          >
            <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M3 7h15a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3zM3 7l12-3v3M16 13.5h.01"
              />
            </svg>
            {{ walletState === 'busy' ? walletStep || 'Ждём кошелёк…' : 'Оплатить кошельком' }}
          </button>
          <p v-if="mounted && !hasWallet" class="muted small">
            Подойдёт MetaMask или другой кошелёк в браузере. Без него переведите вручную.
          </p>
        </template>
        <p v-else class="note">
          Локальная тестовая сеть для показа: кошелёк не нужен, перевод отправляет владелец стенда.
        </p>
        <p
          v-if="walletError"
          class="note"
          :class="walletSent ? 'note-ok' : 'note-err'"
          role="alert"
        >
          {{ walletError }}
        </p>
      </div>

      <details class="manual" :open="!waiting ? false : local || (mounted && !hasWallet)">
        <summary>
          {{
            waiting ? 'Перевести вручную или по QR-коду' : 'Отправили другой перевод? Укажите его'
          }}
        </summary>
        <div class="manual-body">
          <div v-if="waiting" class="manual-grid">
            <div class="manual-fields">
              <div class="field">
                <span class="label">Адрес получателя</span>
                <div class="copy-row">
                  <code class="mono value">{{ props.payment.receiver }}</code>
                  <PublicCopyButton :text="props.payment.receiver" small />
                </div>
              </div>
              <div class="field">
                <span class="label">Сумма, точно до последнего знака</span>
                <div class="copy-row">
                  <code class="mono value">{{ props.payment.amountEth }} ETH</code>
                  <PublicCopyButton :text="props.payment.amountEth" small />
                </div>
                <span class="hint">По последним цифрам суммы мы узнаём ваш перевод.</span>
              </div>
              <p class="small muted">
                Сеть Sepolia (тестовая).
                <template v-if="mounted">Оплатить до {{ publicWhen(props.expiresAt) }}.</template>
              </p>
            </div>
            <figure class="qr-box">
              <PublicQrCode
                :value="props.payment.paymentUri"
                label="QR-код для перевода из кошелька"
              />
              <figcaption class="xs muted">Отсканируйте в мобильном кошельке</figcaption>
            </figure>
          </div>
          <form class="hash-form" novalidate @submit.prevent="submitHash">
            <div class="field" :class="{ 'is-error': hashError }">
              <label for="tx-hash">Номер транзакции</label>
              <div class="copy-row">
                <input
                  id="tx-hash"
                  v-model="hashInput"
                  class="input mono"
                  placeholder="0x…"
                  autocomplete="off"
                  spellcheck="false"
                />
                <button class="btn" type="submit" :disabled="hashBusy">
                  {{ hashBusy ? 'Проверяем…' : 'Отправить' }}
                </button>
              </div>
              <span class="hint">{{
                hashError || 'Необязательно: перевод на точную сумму мы найдём сами.'
              }}</span>
            </div>
          </form>
        </div>
      </details>
    </template>
  </div>
</template>

<style scoped>
.crypto {
  display: grid;
  gap: var(--s-4);
}
.found {
  display: grid;
  gap: var(--s-2);
}
.wallet {
  display: grid;
  gap: var(--s-3);
}
.manual {
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--surface);
}
.manual summary {
  cursor: pointer;
  padding: var(--s-3) var(--s-4);
  font-weight: 600;
  font-size: var(--text-sm);
}
.manual-body {
  padding: 0 var(--s-4) var(--s-4);
  display: grid;
  gap: var(--s-4);
}
.manual-grid {
  display: grid;
  grid-template-columns: 1fr 180px;
  gap: var(--s-5);
  align-items: start;
}
.manual-fields {
  display: grid;
  gap: var(--s-4);
  min-width: 0;
}
.label {
  font-weight: 600;
  font-size: var(--text-sm);
}
.copy-row {
  display: flex;
  gap: var(--s-2);
  align-items: center;
}
.copy-row .input {
  flex: 1 1 auto;
  min-width: 0;
}
.value {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  padding: 8px 10px;
  font-size: var(--text-sm);
}
.qr-box {
  margin: 0;
  display: grid;
  gap: 6px;
  justify-items: center;
  text-align: center;
}
@media (max-width: 639px) {
  .manual-grid {
    grid-template-columns: 1fr;
  }
  .qr-box {
    max-width: 220px;
    margin: 0 auto;
  }
  .copy-row {
    flex-wrap: wrap;
  }
}
</style>
