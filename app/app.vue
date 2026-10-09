<script setup lang="ts">
// Tandem shell: resolve session/auth-config/version once (SSR), share via useState.
const session = useAppSession()
const authConfig = useAuthConfigState()
const appVersion = useAppVersion()
useSessionRefreshing()

const { data: sess } = await useFetch('/api/auth-session')
if (sess.value) session.value = sess.value as unknown as typeof session.value

const { data: ac } = await useFetch('/api/auth-config')
authConfig.value = (ac.value as unknown as typeof authConfig.value) ?? null

const { data: v } = await useFetch('/api/version')
if (v.value?.version) appVersion.value = v.value.version
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
