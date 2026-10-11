<script setup lang="ts">
// Tandem shell: resolve session/auth-config/version once (SSR), share via useState.
const session = useAppSession()
const authConfig = useAuthConfigState()
const appVersion = useAppVersion()
useSessionRefreshing()

const { $client } = useNuxtApp()

const sess = await $client.auth.session()
if (sess) session.value = sess as unknown as typeof session.value

// configLive is an async-iterator object — take only its first snapshot for
// the SSR-shared state (plain POJO, devalue-serializable); the login screen
// is static so a live stream here buys nothing.
const configIter = await $client.auth.configLive()
const first = await configIter.next()
await configIter.return?.()
authConfig.value = (first.value ?? null) as unknown as typeof authConfig.value

const v = await $client.meta.version()
if (v.version) appVersion.value = v.version
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
