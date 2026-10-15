<script setup lang="ts">
// Tandem shell: resolve session/auth-config/version once (SSR), share via useState.
const session = useAppSession()
const authConfig = useAuthConfigState()
const appVersion = useAppVersion()
useSessionRefreshing()

const { $client } = useNuxtApp()

const sess = await $client.auth.session()
if (sess) session.value = sess as unknown as typeof session.value

// plain GET (SSE law: initial data comes from conventional queries; the
// change-events subscription below refetches when auth-affecting settings/oidc
// change). Plain POJO, devalue-serializable.
authConfig.value = (await $client.auth.config()) as unknown as typeof authConfig.value

// SSE law enforcement: GET queries carry first-load data; this subscription
// only invalidates them after the page is loaded.
useChangeEvents()

const v = await $client.meta.version()
if (v.version) appVersion.value = v.version
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
