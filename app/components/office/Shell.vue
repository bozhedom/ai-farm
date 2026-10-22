<script setup lang="ts">
import type { IconName } from '~/composables/office/icons'
import { officeApi, useOfficeToast } from '~/composables/office/actions'
import { useOfficeLaunch, useOfficeOverview } from '~/composables/office/data'
import { count } from '~/composables/office/format'
import { useOfficeOnline } from '~/composables/office/resource'

const route = useRoute()
const { data: overview } = useOfficeOverview()
const { data: launch } = useOfficeLaunch(30000)
const online = useOfficeOnline()
const { toast } = useOfficeToast()
const menuOpen = ref(false)

useHead({ bodyAttrs: { class: computed(() => (menuOpen.value ? 'menu-open' : '')) } })

type Item = {
  to: string
  label: string
  icon: IconName
  count?: number | null
  alert?: number
  hint?: string
  /** Shorter name for the phone tab bar. */
  short?: string
}
const items = computed<Item[]>(() => {
  const o = overview.value
  const orderAlerts = o?.needsOwner.filter((n) => /order|заказ/i.test(n.kind)).length || 0
  const l = launch.value
  const launchLeft = l ? l.total - l.done : 0
  return [
    { to: '/office', label: 'Обзор', icon: 'home' },
    {
      to: '/office/launch',
      label: 'Запуск',
      icon: 'play',
      alert: launchLeft,
      hint: 'шагов осталось',
    },
    { to: '/office/trading', label: 'Мои биржи', icon: 'chart', short: 'Торговля' },
    { to: '/office/manager', label: 'Менеджер торговли', icon: 'compass' },
    { to: '/office/earnings', label: 'Направления', icon: 'spark' },
    { to: '/office/computer', label: 'Компьютер ИИ', icon: 'screen' },
    { to: '/office/farm', label: 'Ферма идей', icon: 'leaf', short: 'Ферма' },
    { to: '/office/ideas', label: 'Идеи', icon: 'idea', count: o?.totals.ideas },
    { to: '/office/agents', label: 'Агенты', icon: 'agents', count: o?.totals.activeAgents },
    { to: '/office/products', label: 'Продукты', icon: 'box', count: o?.totals.publicProducts },
    {
      to: '/office/orders',
      label: 'Заказы',
      icon: 'list',
      count: o?.totals.orders,
      alert: orderAlerts,
    },
    {
      to: '/office/leads',
      label: 'Клиенты',
      icon: 'clients',
      count: o?.totals.newLeads,
      hint: 'новых запросов',
    },
    { to: '/office/money', label: 'Деньги', icon: 'money' },
  ]
})
// Phone tab bar: what the owner opens most, in menu order; the rest is behind «Ещё».
const tabPaths = ['/office', '/office/launch', '/office/trading', '/office/money']
const tabs = computed(() => items.value.filter((item) => tabPaths.includes(item.to)))
const isActive = (to: string) =>
  to === '/office'
    ? route.path === '/office' || route.path === '/office/'
    : route.path.startsWith(to)
const moreActive = computed(
  () => !tabs.value.some((tab) => isActive(tab.to)) && !route.path.startsWith('/office/login'),
)

const live = computed(() => {
  const o = overview.value
  if (!online.value)
    return { dot: 'is-off', title: 'Нет связи', detail: 'Показываем последнее состояние' }
  if (!o) return { dot: 'is-wait', title: 'Загружаем', detail: '' }
  if (o.mode === 'emergency_stop')
    return { dot: 'is-off', title: 'Остановлено', detail: 'Новые задачи не берём' }
  if (!o.worker.alive)
    return { dot: 'is-wait', title: 'Сервер не отвечает', detail: o.worker.reason }
  if (o.mode === 'paused')
    return { dot: 'is-wait', title: 'Пауза', detail: 'Начатые заказы доделываем' }
  // The next run is on the main screen; the menu only says the farm works.
  return { dot: '', title: 'Ферма работает', detail: '' }
})

watch(
  () => route.fullPath,
  () => (menuOpen.value = false),
)
function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') menuOpen.value = false
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

const loggingOut = ref(false)
async function logout() {
  if (loggingOut.value) return
  loggingOut.value = true
  try {
    await officeApi.logout()
  } catch {
    // The session cookie is cleared server side; the login page is the right place either way.
  }
  await navigateTo('/office/login')
  loggingOut.value = false
}
</script>
<template>
  <div class="office">
    <a class="sr-only skip" href="#office-main">К содержимому</a>
    <aside id="office-menu" class="side" aria-label="Меню кабинета">
      <div class="side-top">
        <NuxtLink class="brand" to="/office"
          ><span class="brand-mark"><OfficeIcon name="leaf" /></span
          ><span>AI Farm<small>Кабинет владельца</small></span></NuxtLink
        >
        <button
          type="button"
          class="btn btn-icon btn-sm btn-ghost side-close"
          aria-label="Закрыть меню"
          @click="menuOpen = false"
        >
          <OfficeIcon name="close" />
        </button>
      </div>
      <nav class="side-nav" aria-label="Разделы">
        <NuxtLink
          v-for="item in items"
          :key="item.to"
          :to="item.to"
          :class="{ 'is-active': isActive(item.to) }"
          :aria-current="isActive(item.to) ? 'page' : undefined"
          ><OfficeIcon :name="item.icon" />{{ item.label }}
          <span
            v-if="item.alert"
            class="count is-alert"
            :title="item.hint ? `${item.alert} ${item.hint}` : `Ждут вас: ${item.alert}`"
            >{{ item.alert }}</span
          >
          <span
            v-else-if="item.count"
            class="count"
            :title="item.hint ? `${count(item.count)} ${item.hint}` : undefined"
            >{{ count(item.count) }}</span
          ></NuxtLink
        >
        <span class="label eyebrow">Управление</span>
        <NuxtLink
          to="/office/settings"
          :class="{ 'is-active': isActive('/office/settings') }"
          :aria-current="isActive('/office/settings') ? 'page' : undefined"
          ><OfficeIcon name="settings" />Настройки</NuxtLink
        >
        <a href="/storefront" target="_blank" rel="noopener"
          ><OfficeIcon name="external" />Открыть сайт</a
        >
        <button type="button" class="side-logout" :disabled="loggingOut" @click="logout">
          <OfficeIcon name="logout" />{{ loggingOut ? 'Выходим' : 'Выйти' }}
        </button>
      </nav>
      <div class="side-foot" role="status">
        <span class="live" :class="{ 'is-quiet': live.dot }"
          ><i class="live-dot" :class="live.dot" />{{ live.title }}</span
        >
        <span v-if="live.detail" class="muted small">{{ live.detail }}</span>
      </div>
    </aside>
    <button
      v-if="menuOpen"
      type="button"
      class="scrim"
      aria-label="Закрыть меню"
      @click="menuOpen = false"
    />
    <div>
      <header class="topbar">
        <button
          type="button"
          class="btn btn-icon btn-sm"
          aria-label="Меню"
          aria-controls="office-menu"
          :aria-expanded="menuOpen"
          @click="menuOpen = !menuOpen"
        >
          <OfficeIcon name="menu" />
        </button>
        <NuxtLink class="brand" to="/office"
          ><span class="brand-mark"><OfficeIcon name="leaf" /></span><span>AI Farm</span></NuxtLink
        >
        <span class="live top-live" :class="{ 'is-quiet': live.dot }"
          ><i class="live-dot" :class="live.dot" /><span class="small">{{
            live.title === 'Ферма работает' ? 'Работает' : live.title
          }}</span></span
        >
      </header>
      <main id="office-main" class="main">
        <p v-if="!online" class="note note-wait offline" role="status">
          <OfficeIcon name="wifi" />Нет связи. Показываем последнее состояние, обновим сами.
        </p>
        <slot />
      </main>
      <nav class="tabbar" aria-label="Разделы">
        <NuxtLink
          v-for="tab in tabs"
          :key="tab.to"
          :to="tab.to"
          :class="{ 'is-active': isActive(tab.to) }"
          :aria-current="isActive(tab.to) ? 'page' : undefined"
          ><OfficeIcon :name="tab.icon" />{{ tab.short ?? tab.label }}</NuxtLink
        >
        <button
          type="button"
          :class="{ 'is-active': moreActive }"
          aria-controls="office-menu"
          :aria-expanded="menuOpen"
          @click="menuOpen = true"
        >
          <OfficeIcon name="menu" />Ещё
        </button>
      </nav>
    </div>
    <Transition name="toast">
      <div
        v-if="toast"
        :key="toast.id"
        class="toast"
        :class="toast.tone === 'err' ? 'is-err' : ''"
        :role="toast.tone === 'err' ? 'alert' : 'status'"
      >
        <OfficeIcon :name="toast.tone === 'err' ? 'close' : 'check'" />{{ toast.text }}
      </div>
    </Transition>
  </div>
</template>
<style scoped>
.side-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-2);
}
.side-close {
  display: none;
}
.side-nav .count.is-alert {
  background: var(--st-err);
  border-color: var(--st-err);
  color: #fff;
}
.side-logout {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border: 0;
  border-radius: var(--r-md);
  background: none;
  color: var(--muted);
  font: inherit;
  font-weight: 500;
  cursor: pointer;
  text-align: left;
}
.side-logout:hover {
  background: var(--canvas-deep);
  color: var(--ink);
}
.live.is-quiet {
  color: var(--ink-2);
}
.top-live {
  margin-left: auto;
}
.skip:focus {
  position: fixed;
  left: 12px;
  top: 12px;
  width: auto;
  height: auto;
  clip: auto;
  z-index: 60;
  background: var(--surface);
  padding: 8px 12px;
  border-radius: var(--r-sm);
}
.offline {
  margin-bottom: var(--s-5);
}
.scrim {
  display: none;
}
.toast {
  position: fixed;
  right: var(--s-6);
  bottom: var(--s-6);
  z-index: 70;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: min(440px, calc(100vw - 32px));
  padding: 12px 16px;
  border-radius: var(--r-md);
  background: var(--ink);
  color: var(--on-ink);
  font-size: var(--text-sm);
  box-shadow: var(--shadow-lg);
}
.toast.is-err {
  background: var(--st-err-ink);
}
.toast-enter-active,
.toast-leave-active {
  transition:
    opacity var(--dur) var(--ease),
    transform var(--dur) var(--ease);
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
@media (max-width: 1023px) {
  .side-close {
    display: inline-flex;
  }
  .scrim {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 35;
    border: 0;
    background: rgba(23, 26, 33, 0.38);
  }
  .toast {
    left: var(--gutter);
    right: var(--gutter);
    bottom: calc(76px + env(safe-area-inset-bottom));
    max-width: none;
  }
}
</style>
