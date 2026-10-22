<script setup lang="ts">
// One shell for every office page: the menu, live status and polling survive navigation.
// Only the login page stands alone, because the menu needs a session.
const route = useRoute()
const bare = computed(() => route.path.startsWith('/office/login'))
useHead({
  htmlAttrs: { class: 'ds' },
  titleTemplate: (title) => (title && title !== 'AI Farm' ? `${title}. AI Farm` : 'AI Farm'),
})
</script>
<template>
  <NuxtPage v-if="bare" />
  <OfficeShell v-else><NuxtPage /></OfficeShell>
</template>
