<script setup lang="ts">
const password = ref(''),
  error = ref(''),
  busy = ref(false)
async function login() {
  busy.value = true
  error.value = ''
  try {
    await $fetch('/api/auth/login', { method: 'POST', body: { password: password.value } })
    await navigateTo('/')
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <main class="login-page">
    <div class="login-art">
      <span class="brand-mark"><i /><i /><i /><i /></span>
      <div class="eyebrow">AI FARM / EXPERIMENT 001</div>
      <h1>Идеи работают.<br />Вы видите результат.</h1>
      <p>Исследование, проверка и исполнение<br />в одной автономной лаборатории.</p>
      <div class="orbit">
        <span>Исследовать</span><span>Проверять</span><span>Создавать</span><span>Измерять</span>
      </div>
      <small>Ограниченные действия. Проверяемые решения.</small>
    </div>
    <form class="login-card" @submit.prevent="login">
      <div class="eyebrow">КАБИНЕТ ВЛАДЕЛЬЦА</div>
      <h2>Добро пожаловать</h2>
      <p class="muted">Войдите, чтобы наблюдать за работой системы и управлять экспериментами.</p>
      <label for="password">Пароль владельца</label
      ><input
        id="password"
        v-model="password"
        type="password"
        autocomplete="current-password"
        required
        autofocus
        placeholder="Введите пароль"
      />
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <button class="button primary" :disabled="busy">
        {{ busy ? 'Входим…' : 'Войти в лабораторию →' }}
      </button>
      <p class="login-hint">
        Закрытый экспериментальный стенд.<br />Оплаты работают только в тестовом режиме.
      </p>
    </form>
  </main>
</template>
