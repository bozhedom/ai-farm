<script setup lang="ts">
const { state, failure, refresh } = useFarm()
const now = ref(Date.now())
const route = useRoute()
const menu = [
  ['/', '◈', 'Обзор'],
  ['/?view=hypotheses', '⌕', 'Гипотезы'],
  ['/?view=strategies', '◇', 'Стратегии'],
  ['/catalog', '▦', 'Продукты'],
  ['/?view=orders', '≡', 'Заказы'],
  ['/?view=audit', '↳', 'Журнал'],
]
const active = (url: string) => route.fullPath === url
let timer: ReturnType<typeof setInterval>
onMounted(() => {
  void refresh()
  timer = setInterval(() => {
    now.value = Date.now()
    void refresh()
  }, 2000)
})
onUnmounted(() => clearInterval(timer))
async function logout() {
  await $fetch('/api/auth/logout', { method: 'POST', body: {} })
  state.value = null
  await navigateTo('/login')
}
const workerOk = computed(
  () =>
    !failure.value &&
    state.value?.state?.worker_heartbeat &&
    now.value - new Date(state.value.state.worker_heartbeat).getTime() < 30000,
)
</script>
<template>
  <div class="workspace">
    <aside class="sidebar">
      <NuxtLink to="/" class="brand"
        ><span class="brand-mark"><i /><i /><i /><i /></span
        ><span>AI Farm<small>Лаборатория продуктов</small></span></NuxtLink
      >
      <div class="sidebar-label">РАБОЧЕЕ ПРОСТРАНСТВО</div>
      <nav aria-label="Главное меню">
        <NuxtLink
          v-for="[url, icon, label] in menu"
          :key="url"
          :to="url"
          :class="{ active: active(url!) }"
          ><span aria-hidden="true">{{ icon }}</span
          >{{ label }}</NuxtLink
        >
      </nav>
      <div class="sidebar-bottom">
        <div class="worker-state">
          <span class="dot" :class="workerOk ? 'green' : 'amber'" />
          {{ workerOk ? 'Worker на связи' : 'Worker не на связи' }}
        </div>
        <p>Политика v1 · 4 стратегии<br />Один владелец · тестовый контур</p>
        <button class="quiet light" @click="logout">Выйти из кабинета ↗</button>
      </div>
    </aside>
    <div class="main-wrap">
      <header class="topbar">
        <span>Рабочая среда <span class="slash">/</span> <strong>Лаборатория</strong></span>
        <div class="topbar-right">
          <span class="mode-badge">{{
            state?.config?.modelProvider === 'yandex'
              ? 'Yandex · API'
              : state?.config?.modelProvider === 'ollama'
                ? state.config.model + ' · локально'
                : 'Демонстрация · без API'
          }}</span
          ><span class="avatar">В</span>
        </div>
      </header>
      <main class="main-content">
        <div v-if="failure" class="notice error" role="alert">{{ failure }}</div>
        <slot />
      </main>
      <footer>
        AI Farm · исследуем гипотезы, измеряем результат <span>Тестовые платежи ≠ выручка</span>
      </footer>
    </div>
  </div>
</template>
