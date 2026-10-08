<script setup lang="ts">
const password = ref(''),
  error = ref(''),
  busy = ref(false)
async function login() {
  busy.value = true
  error.value = ''
  try {
    await $fetch('/api/auth/login', { method: 'POST', body: { password: password.value } })
    await navigateTo('/office')
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
      <div class="eyebrow">AI Farm</div>
      <h1>Ваша ИИ-ферма<br />идей и текстов</h1>
      <p>Сервис исследует идеи, готовит тексты<br />и проверяет их по исходным материалам.</p>
      <small>Локальная работа. Тестовые заказы.</small>
    </div>
    <form class="login-card" @submit.prevent="login">
      <div class="eyebrow">Кабинет владельца</div>
      <h2>Вход в кабинет</h2>
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
        {{ busy ? 'Входим…' : 'Войти' }}
      </button>
      <p class="login-hint">
        Кабинет доступен только владельцу.<br />Оплаты работают только в тестовом режиме.
      </p>
    </form>
  </main>
</template>
