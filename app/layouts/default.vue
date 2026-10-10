<script setup lang="ts">
// Dashboard shell (Nuxt UI UDashboardGroup): login screen when unauthenticated,
// sidebar + content when signed in. Session/auth-config via useState (app.vue).
const session = useAppSession()
const authConfig = useAuthConfigState()
const appVersion = useAppVersion()
const companyName = computed(() => authConfig.value?.companyName?.trim() || 'Tandem')
const { refreshSession } = useSessionRefreshing()
const { $authClient } = useNuxtApp()
const toast = useToast()

const loginEmail = ref('')
const loginPassword = ref('')
const loginError = ref('')
const busy = ref(false)

async function login() {
  busy.value = true
  loginError.value = ''
  try {
    const res = await $authClient.signIn.email({ email: loginEmail.value, password: loginPassword.value })
    if (res.error) {
      loginError.value = res.error.message || 'Invalid email or password'
    }
    else {
      await refreshSession()
      // cookie is set server-side; a full reload guarantees SSR picks it up
      if (window.location) window.location.reload()
    }
  }
  catch {
    loginError.value = 'Invalid email or password'
  }
  finally {
    busy.value = false
  }
}

async function oidcLogin(providerId: string) {
  try {
    const res = await $fetch<{ url: string }>('/auth/sign-in/social', {
      method: 'POST',
      body: { provider: providerId, callbackURL: '/' },
    })
    if (res?.url) window.location.href = res.url
    else throw new Error('no authorization url returned')
  }
  catch {
    toast.add({ title: 'SSO unavailable', description: 'OIDC provider not reachable', color: 'error' })
  }
}

async function logout() {
  await $authClient.signOut()
  await refreshSession()
}

const nav = [
  { label: 'Overview', icon: 'i-lucide-layout-dashboard', to: '/' },
  { label: 'Vault', icon: 'i-lucide-shield', to: '/vault' },
  { label: 'Environments', icon: 'i-lucide-server', to: '/environments' },
  { label: 'Employees', icon: 'i-lucide-users', to: '/employees' },
  { label: 'Settings', icon: 'i-lucide-settings', to: '/settings' },
]
</script>

<template>
  <div class="min-h-screen bg-zinc-50 dark:bg-zinc-950">
    <!-- ===================== LOGIN ===================== -->
    <div v-if="!session" class="flex min-h-screen items-center justify-center p-6">
      <div class="w-full max-w-sm">
        <div class="mb-8 flex flex-col items-center gap-2 text-center">
          <div class="flex size-12 items-center justify-center rounded-2xl bg-primary shadow-sm">
            <UIcon name="i-lucide-users" class="size-6 text-inverted" />
          </div>
          <h1 class="text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">{{ companyName }}</h1>
          <p class="text-sm text-zinc-500">Humans and AI employees, one workspace</p>
        </div>

        <UCard :ui="{ root: 'shadow-sm' }">
          <UForm v-if="authConfig?.passwordEnabled !== false" :state="{ email: loginEmail, password: loginPassword }" class="space-y-4" @submit="login">
            <UFormField label="Email" name="email">
              <UInput v-model="loginEmail" type="email" icon="i-lucide-mail" placeholder="you@example.com" class="w-full" size="lg" required />
            </UFormField>
            <UFormField label="Password" name="password">
              <UInput v-model="loginPassword" type="password" icon="i-lucide-lock" class="w-full" size="lg" required />
            </UFormField>
            <UAlert v-if="loginError" icon="i-lucide-shield-alert" color="error" variant="subtle" :title="loginError" />
            <UButton type="submit" block size="lg" :loading="busy" label="Sign in" />
          </UForm>
          <UButton
            v-for="prov in (authConfig?.providers ?? [])"
            :key="prov.id"
            block size="lg" variant="outline" icon="i-lucide-key-round"
            :label="`Sign in with ${prov.label}`"
            class="mt-3"
            @click="oidcLogin(prov.id)"
          />
        </UCard>
      </div>
    </div>

    <!-- ===================== APP (dashboard shell) ===================== -->
    <UDashboardGroup v-else unit="rem">
      <UDashboardSidebar id="tandem-sidebar" :min-size="14" :default-size="16" :max-size="22" collapsible resizable>
        <template #header="{ collapsed }">
          <NuxtLink to="/" class="flex items-center gap-2.5 min-w-0">
            <div class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10">
              <UIcon name="i-lucide-users" class="size-5 text-primary" />
            </div>
            <div v-if="!collapsed" class="flex min-w-0 flex-col">
              <span class="truncate text-sm font-semibold leading-tight text-zinc-900 dark:text-white">{{ companyName }}
                <span class="font-mono text-[10px] font-normal text-zinc-400">v{{ appVersion }}</span>
              </span>
              <span class="text-xs leading-tight text-zinc-400">{{ companyName.toLowerCase() === 'tandem' ? 'company workspace' : 'workspace' }}</span>
            </div>
          </NuxtLink>
        </template>

        <UNavigationMenu :items="nav" orientation="vertical" class="px-2" />

        <template #footer="{ collapsed }">
          <div class="flex w-full items-center gap-2" :class="collapsed ? 'flex-col' : ''">
            <UAvatar :alt="session.user.name" size="xs" />
            <div v-if="!collapsed" class="min-w-0 flex-1">
              <p class="truncate text-xs font-medium text-zinc-900 dark:text-white">{{ session.user.name }}</p>
              <p class="truncate text-[11px] text-zinc-400">{{ session.user.role }}</p>
            </div>
            <UButton
              icon="i-lucide-log-out" color="neutral" variant="ghost" size="xs"
              :aria-label="collapsed ? 'Sign out' : undefined"
              @click="logout"
            />
          </div>
        </template>
      </UDashboardSidebar>

      <slot />
    </UDashboardGroup>
  </div>
</template>
