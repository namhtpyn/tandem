<script setup lang="ts">
// Tandem shell: resolve session/auth-config/version once (SSR), share via useState.
const session = useAppSession()
const authConfig = useAuthConfigState()
const appVersion = useAppVersion()
useSessionRefreshing()

const { $client } = useNuxtApp()

const sess = await $client.auth.session()
if (sess) session.value = sess as unknown as typeof session.value

authConfig.value = (await $client.auth.configLive()) as unknown as typeof authConfig.value

const v = await $client.meta.version()
if (v.version) appVersion.value = v.version
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
