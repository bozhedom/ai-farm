<script setup lang="ts">
import type { PublicCatalog } from '../../core/contracts/public'
import { savedOrders, tokenFromLink, type SavedOrder } from '~/utils/public-site'

useHead({ title: 'AI Farm: тексты для малого бизнеса за 5 минут' })
const { data, error, refresh, pending } = await useFetch<PublicCatalog>('/api/public/catalog')
const services = computed(() => data.value?.services || [])

const shelfColors: Record<string, string> = {
  'Для магазина': 'var(--sky)',
  'Для сайта': 'var(--brand)',
  'Для соцсетей': 'var(--plum)',
  'Для найма': 'var(--clay)',
  'Тексты и документы': 'var(--sun)',
}
const shelves = computed(() => [...new Set(services.value.map((s) => s.category))])
const shelf = ref('all')
const shown = computed(() =>
  shelf.value === 'all' ? services.value : services.value.filter((s) => s.category === shelf.value),
)
const plural = (n: number, one: string, few: string, many: string) =>
  n % 10 === 1 && n % 100 !== 11
    ? one
    : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)
      ? few
      : many

const saved = ref<SavedOrder[]>([])
onMounted(() => (saved.value = savedOrders()))
const link = ref('')
const linkError = ref('')
function openOrder() {
  const token = tokenFromLink(link.value)
  if (!token) {
    linkError.value = 'Не похоже на ссылку заказа. Скопируйте её целиком.'
    return
  }
  linkError.value = ''
  navigateTo(`/order/${token}`)
}
</script>

<template>
  <PublicShell :notice="data?.notice" :seller="data?.seller" active="catalog">
    <div class="container">
      <section class="hero">
        <div class="rise">
          <h1 class="display">Тексты для малого бизнеса <em>за 5 минут</em></h1>
          <p class="lead">
            Описания товаров, ответы клиентам, посты. Вы присылаете факты, мы пишем.
          </p>
          <div class="hero-cta">
            <a class="btn btn-primary btn-lg" href="#catalog">Выбрать услугу</a>
            <NuxtLink v-if="services[0]" class="btn btn-lg" :to="`/services/${services[0].slug}`"
              >Посмотреть пример</NuxtLink
            >
          </div>
        </div>
        <div class="hero-facts">
          <div class="fact rise">
            <span class="num">2-5<small> мин</small></span>
            <p>Обычно от оплаты до готового текста.</p>
          </div>
          <div class="fact rise">
            <span class="num">{{ services.length }}</span>
            <p>
              {{ plural(services.length, 'Услуга', 'Услуги', 'Услуг') }} в продаже сейчас. Цена
              известна до оплаты.
            </p>
          </div>
          <div class="fact rise is-sun">
            <span class="num">2</span>
            <p>Шага у каждого текста: автор пишет, проверка сверяет с вашими фактами.</p>
          </div>
        </div>
      </section>

      <section id="catalog" class="section catalog-section">
        <div class="section-head">
          <div>
            <h2>Что можно заказать</h2>
            <p>Цена фиксированная, без переписки и согласований.</p>
          </div>
          <div v-if="shelves.length > 1" class="chips" role="group" aria-label="Задачи">
            <button
              type="button"
              class="chip"
              :class="{ 'is-active': shelf === 'all' }"
              :aria-pressed="shelf === 'all'"
              @click="shelf = 'all'"
            >
              Все
            </button>
            <button
              v-for="name in shelves"
              :key="name"
              type="button"
              class="chip"
              :class="{ 'is-active': shelf === name }"
              :aria-pressed="shelf === name"
              @click="shelf = name"
            >
              {{ name }}
            </button>
          </div>
        </div>
        <div v-if="error" class="note note-err" role="alert">
          Каталог не загрузился.
          <button class="btn btn-sm" :disabled="pending" @click="() => refresh()">Повторить</button>
        </div>
        <div v-else-if="!services.length" class="empty">
          <h3>Скоро здесь появятся услуги</h3>
          <p>Мы проверяем их на примерах и выставим, когда всё будет готово.</p>
        </div>
        <template v-else>
          <p v-if="data && !data.acceptingOrders" class="note note-wait paused" role="status">
            Сейчас заказы не принимаем. Загляните через час.
          </p>
          <div class="catalog">
            <PublicServiceCard
              v-for="service in shown"
              :key="service.slug"
              :service="service"
              :shelf-color="shelfColors[service.category] || 'var(--brand)'"
              class="rise"
            />
          </div>
        </template>
      </section>

      <section id="how" class="section how-section">
        <div class="section-head">
          <div>
            <h2>Как это работает</h2>
            <p>Три шага, без звонков и менеджеров.</p>
          </div>
        </div>
        <div class="how">
          <article>
            <h3>Выбираете услугу и вставляете факты</h3>
            <p>Характеристики, условия, старый текст. Чем больше фактов, тем точнее результат.</p>
          </article>
          <article>
            <h3>Оплачиваете, агенты пишут</h3>
            <p>Один агент пишет, второй сверяет текст с вашими фактами. Выдумок не пропускаем.</p>
          </article>
          <article>
            <h3>Получаете текст по ссылке</h3>
            <p>Текст на странице заказа и файлом .txt. Ссылка остаётся у вас.</p>
          </article>
        </div>
      </section>

      <section id="orders" class="section orders-section">
        <div class="card card-tint-brand card-pad-lg lookup">
          <div>
            <h2>Уже заказывали?</h2>
            <p class="muted">Откройте заказ по ссылке, которую вы сохранили.</p>
            <ul v-if="saved.length" class="saved">
              <li v-for="order in saved" :key="order.token">
                <NuxtLink :to="`/order/${order.token}`">{{ order.name }}</NuxtLink>
              </li>
            </ul>
          </div>
          <form class="lookup-form" @submit.prevent="openOrder">
            <label class="sr-only" for="order-link">Ссылка на заказ</label>
            <input
              id="order-link"
              v-model="link"
              class="input"
              placeholder="Вставьте ссылку на заказ"
              autocomplete="off"
            />
            <button class="btn btn-primary" type="submit">Открыть</button>
            <p v-if="linkError" class="hint-err" role="alert">{{ linkError }}</p>
          </form>
        </div>
      </section>
    </div>
  </PublicShell>
</template>

<style scoped>
.hero {
  padding: var(--s-16) 0 var(--s-12);
  display: grid;
  grid-template-columns: 1.15fr 0.85fr;
  gap: var(--s-10);
  align-items: center;
}
.hero .display {
  max-width: 13ch;
}
.hero .display em {
  font-style: normal;
  color: var(--brand);
}
.hero .lead {
  max-width: 44ch;
  margin-top: var(--s-5);
}
.hero-cta {
  display: flex;
  gap: var(--s-3);
  margin-top: var(--s-8);
  flex-wrap: wrap;
}
.hero-facts {
  display: grid;
  gap: var(--s-3);
}
.fact {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  padding: var(--s-5);
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--s-4);
  align-items: center;
}
.fact .num {
  font-size: var(--num-lg);
  color: var(--brand-ink);
  min-width: 80px;
}
.fact .num small {
  font-size: 0.45em;
}
.fact p {
  color: var(--ink-2);
}
.fact.is-sun {
  background: var(--sun-soft);
  border-color: transparent;
}
.fact.is-sun .num {
  color: var(--sun-ink);
}
.catalog-section {
  padding-top: var(--s-6);
}
.section-head h2 {
  font-size: var(--text-2xl);
}
.paused {
  margin-bottom: var(--s-5);
}
.catalog {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--s-5);
}
.how-section {
  padding-top: var(--s-8);
}
.orders-section {
  padding-top: 0;
}
.lookup {
  display: grid;
  grid-template-columns: 1fr minmax(280px, 420px);
  gap: var(--s-5);
  align-items: center;
}
.lookup .muted {
  margin-top: 4px;
}
.saved {
  margin-top: var(--s-3);
  padding-left: 18px;
}
.saved li + li {
  margin-top: 4px;
}
.lookup-form {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-3);
}
.lookup-form .input {
  flex: 1 1 200px;
  width: auto;
}
.hint-err {
  flex-basis: 100%;
  color: var(--st-err-ink);
  font-size: var(--text-sm);
}
@media (max-width: 1023px) {
  .catalog {
    grid-template-columns: 1fr 1fr;
  }
  .hero {
    grid-template-columns: 1fr;
    padding-top: var(--s-10);
  }
}
@media (max-width: 639px) {
  .catalog {
    grid-template-columns: 1fr;
  }
  .hero {
    padding: var(--s-8) 0 var(--s-6);
  }
  .hero .display {
    max-width: none;
  }
  .lookup {
    grid-template-columns: 1fr;
  }
}
</style>
