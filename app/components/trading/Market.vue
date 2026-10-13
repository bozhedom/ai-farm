<script setup lang="ts">
import type { TradingView, TradingMarketView } from '../../../core/contracts/trading'
import { officeFetch, useOfficeResource } from '~/composables/office/resource'
import { pct, shortTime, tradingReason, usdt } from '~/utils/trading'

const props = defineProps<{ view: TradingView; busy: boolean; offline: boolean }>()
defineEmits<{ check: [] }>()
const search = ref('')
const filter = ref('ready')
const page = ref(1)
const appliedSearch = ref('')
let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(search, (value) => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    appliedSearch.value = value.trim()
    page.value = 1
  }, 250)
})
watch(filter, () => {
  page.value = 1
})
onBeforeUnmount(() => clearTimeout(searchTimer))
const url = computed(
  () =>
    `/api/trading/market?${new URLSearchParams({ exchange: props.view.exchange, mode: props.view.mode, search: appliedSearch.value, filter: filter.value, page: String(page.value) })}`,
)
const {
  data: report,
  status,
  pending,
} = useOfficeResource<TradingMarketView>(url, () => officeFetch(url.value), { interval: 10_000 })
const price = (value: string) =>
  usdt(value, Math.min(18, Math.max(2, 2 - Math.floor(Math.log10(Number(value) || 1)))))
</script>

<template>
  <section class="t-stack market-workspace">
    <div class="section-heading">
      <div>
        <p class="market-eyebrow">Разведчик рынка</p>
        <h2>Монеты для работы</h2>
        <p class="t-muted">
          Ищет ликвидные монеты с движением цены и передаёт их торговым стратегиям.
        </p>
      </div>
      <button
        class="t-button"
        :disabled="busy || offline || !view.readiness.keys"
        @click="$emit('check')"
      >
        {{ busy ? 'Проверяем рынок…' : 'Проверить рынок' }}
      </button>
    </div>
    <p v-if="pending" class="t-muted" role="status">Загружаем наблюдения…</p>
    <p v-if="status.error" class="t-alert" role="status">
      Не удалось обновить список. {{ status.error }}
    </p>
    <template v-if="report">
      <p v-if="report.error" class="t-alert" role="status">
        {{ tradingReason(report.error) }} Последний список сохранён; новые покупки ждут успешной
        проверки.
      </p>
      <div v-if="!report.scannedAt" class="t-empty">
        <h3>Начнём с обзора рынка</h3>
        <p>
          Запустите тренировку или нажмите «Проверить рынок». Разведчик получит список пар этой
          биржи, сравнит оборот и движение цены, затем проверит стаканы кандидатов.
        </p>
      </div>
      <template v-else>
        <dl class="market-counts">
          <div>
            <dt>Пар к USDT найдено</dt>
            <dd>{{ report.total }}</dd>
          </div>
          <div>
            <dt>Прошли первичный отбор</dt>
            <dd>{{ report.screened }}</dd>
          </div>
          <div>
            <dt>Готовы к наблюдению</dt>
            <dd>{{ report.ready }}</dd>
          </div>
        </dl>
        <p class="market-updated t-muted">
          Проверено {{ shortTime(report.scannedAt) }}. Пересмотр каждые
          {{ report.limits.scanMinutes }} минут при запущенном портфеле.<span v-if="!report.fresh">
            Список устарел, новые покупки ждут обновления.</span
          >
        </p>
        <div v-if="report.active.length" class="market-assignments" aria-label="Монеты у агентов">
          <div v-for="a in report.active" :key="a.name + a.symbol">
            <span>{{ a.name }}</span
            ><strong>{{ a.symbol.split('-')[0] }}</strong
            ><small>{{
              view.status === 'stopped'
                ? 'Назначение сохранено, заявки остановлены'
                : a.holding
                  ? 'Куплена, контролируем выход'
                  : view.status === 'paused'
                    ? 'Покупки на паузе'
                    : 'Ищет момент для покупки'
            }}</small>
          </div>
        </div>
        <div class="market-filters">
          <label
            >Найти монету<input
              v-model="search"
              type="search"
              maxlength="40"
              placeholder="Например, SOL или PEPE"
          /></label>
          <label
            >Показать<select v-model="filter" aria-label="Показать">
              <option value="ready">Прошли проверку</option>
              <option value="all">Все найденные</option>
            </select></label
          >
        </div>
        <div v-if="!report.coins.length" class="t-empty">
          <h3>{{ appliedSearch ? 'Совпадений нет' : 'Пока нет подходящих монет' }}</h3>
          <p>
            {{
              appliedSearch
                ? 'Попробуйте другое название или выберите все найденные пары.'
                : 'Разведчик повторит отбор. Свободные деньги остаются в USDT; уже купленные монеты продолжают контролироваться.'
            }}
          </p>
        </div>
        <div v-else class="market-table-wrap">
          <table class="market-table">
            <caption class="visually-hidden">
              Монеты выбранной биржи и результат проверки
            </caption>
            <thead>
              <tr>
                <th scope="col">Монета</th>
                <th scope="col">Цена, USDT</th>
                <th scope="col">За 24 ч</th>
                <th scope="col" class="market-volume">Оборот, USDT</th>
                <th scope="col">Решение</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="coin in report.coins" :key="coin.symbol">
                <th scope="row">{{ coin.symbol.split('-')[0] }}<small>USDT</small></th>
                <td>{{ Number(coin.price) > 0 ? price(coin.price) : 'Нет цены' }}</td>
                <td :class="coin.changeBps < 0 ? 't-negative' : 't-positive'">
                  {{ coin.changeBps > 0 ? '+' : '' }}{{ pct(coin.changeBps) }}
                </td>
                <td class="market-volume">{{ usdt(coin.turnover, 0) }}</td>
                <td>
                  <span :class="{ 'market-ready': coin.eligible }">{{
                    tradingReason(coin.reason)
                  }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="report.matches > report.pageSize" class="market-pagination">
          <button class="t-button" :disabled="page <= 1" @click="page--">Назад</button>
          <span>Страница {{ page }} из {{ Math.ceil(report.matches / report.pageSize) }}</span>
          <button
            class="t-button"
            :disabled="page * report.pageSize >= report.matches"
            @click="page++"
          >
            Дальше
          </button>
        </div>
        <p class="t-muted">
          Прошедшая проверку монета ещё не куплена. Агент ждёт свой сигнал; недавний рост не обещает
          прибыль.
        </p>
      </template>
      <details class="t-details">
        <summary>Как выбираются и меняются монеты</summary>
        <div class="t-details-body">
          <p>
            Разведчик получает весь доступный каталог спотовых пар к USDT на этой бирже. Проверяет
            оборот от {{ usdt(String(report.limits.dailyTurnover), 0) }} USDT в сутки, разницу
            покупки и продажи до {{ pct(report.limits.maxSpreadBps) }}, движение цены и ограничения
            биржи.
          </p>
          <p>
            У {{ report.limits.candidates }} кандидатов за проход проверяет два часа минутных свечей
            и глубину стакана. Для входа нужны заявки хотя бы на
            {{ report.limits.bookDepthUsdt }} USDT с каждой стороны в пределах допустимого
            проскальзывания. Тихие, перегретые, неликвидные и неподходящие инструменты пропускает.
          </p>
          <p>
            Если монета перестала проходить проверку или {{ report.limits.idleHours }} часов нет
            сделки, свободный агент может взять другую. Пару меняем только после полного закрытия
            позиции. Остаток, который биржа не позволяет продать, остаётся в учёте.
          </p>
          <p>
            Купленная монета контролируется по стопу, цели и времени: после
            {{ report.limits.idleHours }} часов без подходящего движения возможен выход, через
            {{ report.limits.holdHours }} часа выставляется заявка на закрытие. Продажа зависит от
            стакана и может принести убыток. Смена пары не обнуляет результат стратегии.
          </p>
        </div>
      </details>
      <details v-if="report.assignments.length" class="t-details">
        <summary>Последние назначения монет</summary>
        <ol class="market-journal">
          <li v-for="a in report.assignments" :key="a.id">
            <div>
              <strong
                >{{ a.name }}: {{ a.previous ? a.previous.split('-')[0] + ' / ' : ''
                }}{{ a.symbol.split('-')[0] }}</strong
              ><span>{{ tradingReason(a.reason) }}</span>
            </div>
            <time :datetime="a.at">{{ shortTime(a.at) }}</time>
          </li>
        </ol>
      </details>
    </template>
    <details class="t-details">
      <summary>На чём зарабатывают в крипте и что умеет этот бот</summary>
      <div class="t-details-body market-methods">
        <p>
          <strong>Движение цены. Работает здесь.</strong> Три стратегии: покупка после отката,
          следование росту и вход при пробое диапазона. Каждая учитывает комиссии и может потерять
          деньги при неверном сигнале. Разведчик расширяет выбор монет, а не гарантирует доходность.
        </p>
        <p>
          <strong>Сетка и регулярные покупки.</strong> Сетка выставляет покупки и продажи внутри
          коридора, DCA покупает по расписанию. Сетка уязвима при выходе цены из диапазона;
          регулярные покупки сами по себе не создают прибыль. Ограниченные варианты доступны в
          тренировке: откройте «Стратегии» и выберите «Сетка и DCA».
          <a
            href="https://www.bybit.com/en/learn/bybit-trading-bot/what-is-spot-grid-trading-bot"
            target="_blank"
            rel="noopener noreferrer"
            >О сетке у Bybit</a
          >
        </p>
        <p>
          <strong>Арбитраж между биржами.</strong> Доход ищут в разнице исполнимых цен после
          комиссий. Для двух одновременных сделок нужны средства с обеих сторон, контроль исполнения
          и пополнение запасов. Сейчас счета работают самостоятельно; переводов и парных сделок
          между ними нет. Снимки разницы цен доступны в разделе «Направления».
        </p>
        <p>
          <strong>Фандинг.</strong> Спот сочетают с противоположной позицией во фьючерсе ради
          периодических выплат. Ставка меняется, остаются риск ликвидации, расхождения цен и
          комиссии. В приложении фьючерсы отключены.
          <a
            href="https://www.kraken.com/learn/futures-trading-funding-rate-arbitrage"
            target="_blank"
            rel="noopener noreferrer"
            >Как устроен фандинг</a
          >
        </p>
        <p>
          <strong>Стейкинг, займы и пулы ликвидности.</strong> Вознаграждения связаны с блокировкой
          активов, работой сети, заёмщиками или обменами в пуле. Добавляются риски контрагента,
          смарт-контракта и изменения стоимости активов. Здесь эти продукты и кошельки не
          подключены.
          <a
            href="https://www.kraken.com/learn/staking-vs-yield-farming"
            target="_blank"
            rel="noopener noreferrer"
            >Стейкинг и пулы</a
          >
        </p>
      </div>
    </details>
  </section>
</template>
