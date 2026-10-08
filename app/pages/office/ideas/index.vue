<script setup lang="ts">
import type { IdeaStatus, OfficeIdea } from '../../../../core/contracts/office'
import { useOfficeIdeas, useOfficeOverview, type IdeaFilters } from '~/composables/office/data'
import { count, dayWord, withCount } from '~/composables/office/format'
import {
  ideaStatus,
  ideaStatusFilter,
  ideaStatusOrder,
  launchBadge,
} from '~/composables/office/labels'

useHead({ title: 'Идеи' })
const route = useRoute()
const router = useRouter()
const tab = computed(() => (route.query.tab === 'reports' ? 'reports' : 'rating'))
const setTab = (next: 'rating' | 'reports') =>
  router.replace({ query: { ...route.query, tab: next === 'reports' ? 'reports' : undefined } })

const { data: overview } = useOfficeOverview()
const filters = ref<IdeaFilters>({ status: '', category: '' })
const launch = ref<'' | 'farm' | 'human'>('')
const { data, status, pending, refresh, more } = useOfficeIdeas(filters)

// Industries seen so far stay as chips even while one of them is selected.
const knownCategories = ref<string[]>([])
watch(
  () => data.value?.items,
  (items) => {
    if (!items || filters.value.category) return
    const next = new Set(knownCategories.value)
    for (const idea of items) if (idea.category) next.add(idea.category)
    knownCategories.value = [...next].sort((a, b) => a.localeCompare(b, 'ru'))
  },
  { immediate: true },
)

const items = computed(() =>
  (data.value?.items || []).filter(
    (idea) =>
      !launch.value || (launch.value === 'farm' ? idea.farmExecutable : !idea.farmExecutable),
  ),
)
const loaded = computed(() => data.value?.items || [])
const summary = computed(() => {
  const list = loaded.value
  const scores = list.map((idea) => idea.rankScore)
  return {
    farm: list.filter((i) => i.farmExecutable && i.status !== 'rejected').length,
    selling: list.filter((i) => i.status === 'productized').length,
    human: list.filter((i) => !i.farmExecutable && i.status !== 'rejected').length,
    rejected: list.filter((i) => i.status === 'rejected').length,
    average: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
    partial: !!data.value?.hasMore,
  }
})
const open = ref<string | null>(null)
const toggle = (id: string) => (open.value = open.value === id ? null : id)
const subtitle = computed(() => {
  const total = data.value?.total ?? overview.value?.totals.ideas
  if (total === undefined) return 'Критик проверяет каждую идею, руководитель ставит балл.'
  if (!total) return 'Идей пока нет. Разведчики принесут первые после поиска.'
  return `${withCount(total, ['идея', 'идеи', 'идей'])} по ${withCount(knownCategories.value.length, ['отрасли', 'отраслям', 'отраслям'])}. Критик проверил каждую, руководитель поставил балл.`
})
const statusOptions: { value: IdeaStatus | ''; label: string }[] = [
  { value: '', label: 'Все статусы' },
  ...ideaStatusOrder.map((value) => ({ value, label: ideaStatusFilter[value] })),
]
const rankOf = (idea: OfficeIdea) => loaded.value.indexOf(idea) + 1
const shortReason = (text: string) => (text.length > 70 ? text.slice(0, 68).trimEnd() + '…' : text)
</script>
<template>
  <div>
    <div class="page-head">
      <div>
        <h1>Идеи</h1>
        <p>{{ subtitle }}</p>
      </div>
      <div class="row">
        <OfficeFindIdeas :mode="overview?.mode" />
      </div>
    </div>

    <div class="chips tabs" role="tablist" aria-label="Вид">
      <button
        type="button"
        role="tab"
        class="chip"
        :class="{ 'is-active': tab === 'rating' }"
        :aria-selected="tab === 'rating'"
        @click="setTab('rating')"
      >
        Рейтинг
      </button>
      <button
        type="button"
        role="tab"
        class="chip"
        :class="{ 'is-active': tab === 'reports' }"
        :aria-selected="tab === 'reports'"
        @click="setTab('reports')"
      >
        <OfficeIcon name="report" size="sm" />Отчёты руководителя
      </button>
    </div>

    <OfficeReports v-if="tab === 'reports'" />

    <template v-else>
      <section class="summary" aria-label="Итоги">
        <div class="stat rise">
          <span class="stat-label">Ферма сделает сама</span
          ><span class="num">{{ summary.farm }}</span
          ><span class="stat-note">{{ summary.selling }} уже в продаже</span>
        </div>
        <div class="stat rise">
          <span class="stat-label">Нужен человек</span><span class="num">{{ summary.human }}</span
          ><span class="stat-note">с планом запуска</span>
        </div>
        <div class="stat rise">
          <span class="stat-label">Отклонил критик</span
          ><span class="num">{{ summary.rejected }}</span
          ><span class="stat-note">риски, запреты, нет спроса</span>
        </div>
        <div class="stat rise">
          <span class="stat-label">Средний балл</span><span class="num">{{ summary.average }}</span
          ><span class="stat-note">{{
            summary.partial ? `среди первых ${loaded.length}` : 'из 100'
          }}</span>
        </div>
      </section>

      <div class="toolbar">
        <div class="chips industry" aria-label="Отрасль">
          <button
            type="button"
            class="chip"
            :class="{ 'is-active': !filters.category }"
            @click="filters.category = ''"
          >
            Все <span v-if="overview" class="n">{{ count(overview.totals.ideas) }}</span>
          </button>
          <button
            v-for="category in knownCategories"
            :key="category"
            type="button"
            class="chip"
            :class="{ 'is-active': filters.category === category }"
            @click="filters.category = filters.category === category ? '' : category"
          >
            {{ category }}
          </button>
        </div>
      </div>
      <div class="toolbar second">
        <div class="chips" aria-label="Кто запускает">
          <button
            type="button"
            class="chip"
            :class="{ 'is-active': launch === 'farm' }"
            :aria-pressed="launch === 'farm'"
            @click="launch = launch === 'farm' ? '' : 'farm'"
          >
            Ферма сделает сама
          </button>
          <button
            type="button"
            class="chip"
            :class="{ 'is-active': launch === 'human' }"
            :aria-pressed="launch === 'human'"
            @click="launch = launch === 'human' ? '' : 'human'"
          >
            Нужен человек
          </button>
        </div>
        <select v-model="filters.status" class="select" aria-label="Статус">
          <option v-for="option in statusOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </div>

      <OfficeState v-if="!data" :status="status" :pending="pending" @retry="refresh" />
      <OfficeEmpty
        v-else-if="!data.total && !filters.status && !filters.category"
        icon="idea"
        title="Идей пока нет"
        text="Нажмите «Найти идеи сейчас», и разведчики начнут поиск."
      />
      <OfficeEmpty
        v-else-if="!items.length"
        icon="search"
        title="Под фильтр ничего не попало"
        text="Снимите фильтр или выберите другую отрасль."
      >
        <button
          type="button"
          class="btn btn-sm"
          @click="((filters.status = ''), (filters.category = ''), (launch = ''))"
        >
          Показать все
        </button>
      </OfficeEmpty>
      <div v-else class="table-wrap ideas">
        <div class="list-head" aria-hidden="true">
          <span>#</span><span>Идея</span><span>Балл</span><span>Статус</span><span>Запуск</span
          ><span />
        </div>
        <article
          v-for="idea in items"
          :key="idea.id"
          class="idea"
          :class="{ 'is-open': open === idea.id, 'is-off': idea.status === 'rejected' }"
        >
          <button
            type="button"
            class="idea-row"
            :aria-expanded="open === idea.id"
            :aria-controls="`idea-${idea.id}`"
            @click="toggle(idea.id)"
          >
            <span class="rank" :class="{ 'is-top': rankOf(idea) <= 3 && !filters.status }">{{
              rankOf(idea)
            }}</span>
            <span class="t">
              <span class="title">{{ idea.title }}</span>
              <span class="ind"
                >{{ idea.category }}. Нашёл {{ idea.agent.name }}, {{ dayWord(idea.createdAt) }}
                <span v-if="idea.duplicateOf" class="badge badge-off badge-plain">Повтор</span>
                <span v-if="idea.isDemo" class="badge badge-plain">Демо</span>
              </span>
            </span>
            <span class="meta">
              <OfficeScore :value="idea.rankScore" :muted="idea.status === 'rejected'" />
              <span><OfficeBadge :badge="ideaStatus[idea.status]" /></span>
              <span v-if="idea.status === 'rejected'" class="why">{{
                shortReason(idea.critique.reason)
              }}</span>
              <span v-else
                ><OfficeBadge :badge="launchBadge(idea)" :dot="!idea.farmExecutable"
              /></span>
            </span>
            <OfficeIcon name="chevron" class="chev" />
          </button>
          <div v-if="open === idea.id" :id="`idea-${idea.id}`" class="detail">
            <p class="verdict">
              <strong
                >{{
                  idea.critique.verdict === 'PASS'
                    ? 'Критик принял'
                    : idea.critique.verdict === 'REVISE'
                      ? 'Критик просит доработать'
                      : 'Критик отклонил'
                }}:</strong
              >
              {{ idea.critique.reason }}
            </p>
            <OfficeIdeaFacts :idea="idea" />
            <div class="detail-actions">
              <NuxtLink class="btn btn-sm" :to="`/office/ideas/${idea.id}`"
                >Открыть карточку</NuxtLink
              >
              <NuxtLink
                v-if="idea.checks.some((c) => c.productId)"
                class="btn btn-ghost btn-sm"
                to="/office/products"
                >Продукт</NuxtLink
              >
            </div>
          </div>
        </article>
      </div>
      <p v-if="data && data.items.length" class="more muted small">
        Показаны {{ items.length }} из {{ data.total }}.
        <button v-if="data.hasMore" type="button" class="link-btn" @click="more">
          Показать ещё
        </button>
      </p>
    </template>
  </div>
</template>
<style scoped>
.tabs {
  margin-bottom: var(--s-5);
}
.summary {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--s-3);
  margin-bottom: var(--s-5);
}
.summary .stat {
  min-height: 0;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-3);
  align-items: center;
  margin-bottom: var(--s-3);
}
.toolbar.second {
  margin-bottom: var(--s-4);
}
.toolbar .select {
  width: auto;
  min-width: 200px;
  margin-left: auto;
}
.ideas {
  overflow: visible;
}
.list-head,
.idea-row {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) 170px 150px 170px 24px;
  gap: var(--s-4);
  align-items: center;
}
.list-head {
  padding: 10px var(--s-5);
  border-bottom: 1px solid var(--line);
}
.list-head span {
  font: 600 var(--text-xs) / 1.2 var(--font-body);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}
.idea {
  border-bottom: 1px solid var(--line);
}
.idea:last-child {
  border-bottom: 0;
}
.idea-row {
  width: 100%;
  padding: var(--s-4) var(--s-5);
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast);
}
.idea-row:hover,
.idea.is-open .idea-row {
  background: var(--surface-2);
}
.t {
  min-width: 0;
}
.title {
  display: block;
  font-weight: 600;
}
.ind {
  display: block;
  font-size: var(--text-sm);
  color: var(--muted);
  margin-top: 2px;
}
.ind .badge {
  margin-left: 4px;
  padding: 1px 8px;
}
.idea.is-off .title {
  color: var(--muted);
}
.meta {
  display: contents;
}
.meta .score {
  min-width: 0;
}
.why {
  font-size: var(--text-sm);
  color: var(--muted);
}
.chev {
  transition: transform var(--dur) var(--ease);
  color: var(--muted);
}
.idea.is-open .chev {
  transform: rotate(180deg);
}
.detail {
  padding: 0 var(--s-5) var(--s-5) calc(44px + var(--s-4) + var(--s-5));
  background: var(--surface-2);
}
.detail :deep(.facts > div) {
  background: var(--surface);
}
.verdict {
  margin-bottom: var(--s-3);
}
.detail-actions {
  display: flex;
  gap: var(--s-2);
  margin-top: var(--s-4);
  flex-wrap: wrap;
}
.more {
  margin-top: var(--s-3);
}
.link-btn {
  border: 0;
  background: none;
  padding: 0;
  color: var(--brand);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
@media (max-width: 1023px) {
  .summary {
    grid-template-columns: repeat(2, 1fr);
  }
  .list-head {
    display: none;
  }
  .idea-row {
    grid-template-columns: 36px minmax(0, 1fr) auto;
    grid-template-areas:
      'rank title score'
      'rank meta meta';
    row-gap: 8px;
    padding: var(--s-4);
  }
  .rank {
    grid-area: rank;
  }
  .t {
    grid-area: title;
  }
  .meta {
    grid-area: meta;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }
  .meta .score {
    order: -1;
    grid-template-columns: auto;
  }
  .meta .score :deep(.bar) {
    display: none;
  }
  .chev {
    display: none;
  }
  .detail {
    padding: 0 var(--s-4) var(--s-4);
  }
  .toolbar .select {
    margin-left: 0;
    width: 100%;
  }
}
.industry {
  flex-wrap: nowrap;
  overflow-x: auto;
  min-width: 0;
  max-width: 100%;
  padding: 2px 0 6px;
  scrollbar-width: thin;
}
@media (max-width: 639px) {
  .industry {
    margin: 0 calc(-1 * var(--gutter));
    padding: 2px var(--gutter);
    max-width: none;
    scrollbar-width: none;
  }
  .industry::-webkit-scrollbar {
    display: none;
  }
}
</style>
