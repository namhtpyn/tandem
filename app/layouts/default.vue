<script setup lang="ts">
import { z } from 'zod';

import { SERVER_UNREACHABLE_COPY } from '~/utils/copy';
// Dashboard shell (Nuxt UI UDashboardGroup): login screen when unauthenticated,
// sidebar + content when signed in. Session/auth-config via useState (app.vue).
import { roleLabel } from '~/utils/ui-labels';

const session = useAppSession();
const authConfig = useAuthConfigState();
const appVersion = useAppVersion();
const companyName = computed(() => authConfig.value?.companyName?.trim() || 'Tandem');
// version chip: only real semver builds get the chip — 'dev'/'main'/empty are
// dev builds and the tiny 'vdev' reads as a rendering bug next to the logo
const versionLabel = computed(() => appVersion.value.replace(/^v/, '').trim());
const showVersionChip = computed(() => /^\d+\.\d+\.\d+/.test(versionLabel.value));
// role suffix only when it adds information — name 'Admin' over role 'ADMIN'
// is the same word twice (case-insensitive compare)
const showRoleSuffix = computed(() => {
  const user = session.value?.user;
  return !!user && user.role.toLowerCase() !== user.name.trim().toLowerCase();
});
const { refreshSession } = useSessionRefreshing();
const { $authClient } = useNuxtApp();
const toast = useToast();

const loginEmail = ref('');
const loginPassword = ref('');
const loginError = ref('');
const busy = ref(false);
// UForm :state needs a stable object — reactive() wrapping the refs keeps both in sync
const loginState = reactive({ email: loginEmail, password: loginPassword });
// frontend form schemas are deliberately loose (repo convention): .email() +
// min(1) only — the real credential check happens server-side
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// distinct failure copy: unreachable server ≠ wrong credentials. The 503 string
// is the shared one (app boot + error page say the same thing).
const SERVER_DOWN = SERVER_UNREACHABLE_COPY;
const BAD_CREDENTIALS = 'Invalid email or password';

async function login() {
  busy.value = true;
  loginError.value = '';
  try {
    const res = await $authClient.signIn.email({ email: loginEmail.value, password: loginPassword.value });
    if (res.error) {
      // 5xx is a server-side failure, not a wrong password — say so instead of
      // blaming the credentials; 401/400 are the explicit auth rejections
      if (res.error.status >= 500) loginError.value = SERVER_DOWN;
      else if (res.error.status === 400 || res.error.status === 401) loginError.value = BAD_CREDENTIALS;
      else loginError.value = res.error.message || BAD_CREDENTIALS;
    } else {
      await refreshSession();
      // cookie is set server-side; a full reload guarantees SSR picks it up
      window.location.reload();
    }
  } catch {
    // the client only throws below the HTTP contract (DNS/socket/TypeError) —
    // the server was never reached, so it cannot be a credentials problem
    loginError.value = SERVER_DOWN;
  } finally {
    busy.value = false;
  }
}

async function oidcLogin(providerId: string, providerLabel: string) {
  try {
    const res = await $fetch<{ url: string }>('/auth/sign-in/social', {
      method: 'POST',
      body: { provider: providerId, callbackURL: '/' },
    });
    if (res?.url) window.location.href = res.url;
    else throw new Error('no authorization url returned');
  } catch {
    toast.add({
      title: 'Sign-in unavailable',
      description: `Sign-in with ${providerLabel} is unavailable right now. Use email and password or try again.`,
      color: 'error',
    });
  }
}

async function logout() {
  try {
    await $authClient.signOut();
  } catch {
    toast.add({ title: "Couldn't sign out — try again", color: 'error' });
    return;
  }
  await refreshSession();
}

const route = useRoute();
// exact to === path would leave detail pages (/tasks/<id>) with no active nav
const nav = computed(() =>
  [
    { label: 'Overview', icon: 'i-lucide-layout-dashboard', to: '/' },
    { label: 'Vault', icon: 'i-lucide-shield', to: '/vault' },
    { label: 'Environments', icon: 'i-lucide-server', to: '/environments' },
    { label: 'Employees', icon: 'i-lucide-users', to: '/employees' },
    { label: 'Tasks', icon: 'i-lucide-list-todo', to: '/tasks' },
    { label: 'Projects', icon: 'i-lucide-folder-kanban', to: '/projects' },
    { label: 'Settings', icon: 'i-lucide-settings', to: '/settings' },
  ].map((item) => ({
    ...item,
    active: item.to === '/' ? route.path === '/' : route.path.startsWith(item.to),
  })),
);
</script>

<template>
  <div class="bg-default min-h-dvh">
    <!-- ===================== LOGIN ===================== -->
    <div v-if="!session" class="flex min-h-dvh items-center justify-center p-6">
      <div class="w-full max-w-sm">
        <div class="mb-8 flex flex-col items-center gap-2 text-center">
          <div class="bg-primary/10 flex size-12 items-center justify-center rounded-xl shadow-sm">
            <UIcon name="i-lucide-users" class="text-primary size-6" />
          </div>
          <h1 class="text-highlighted text-2xl font-bold tracking-tight">{{ companyName }}</h1>
          <p class="text-muted text-sm">Humans and AI employees, one workspace</p>
        </div>

        <UCard :ui="{ root: 'shadow-sm' }">
          <!-- authConfig null = still resolving (unknown, not "password on"):
               render a neutral shimmer instead of guessing — password-disabled
               tenants would otherwise flash the wrong form for a beat -->
          <div v-if="!authConfig" class="space-y-4" aria-hidden="true">
            <div v-for="i in 2" :key="i" class="space-y-1.5">
              <div class="bg-elevated h-4 w-20 animate-pulse rounded-sm" />
              <div class="bg-elevated h-10 animate-pulse rounded-md" />
            </div>
            <div class="bg-elevated h-10 animate-pulse rounded-md" />
          </div>
          <template v-else>
            <UForm
              v-if="authConfig.passwordEnabled !== false"
              :schema="loginSchema"
              :state="loginState"
              class="space-y-4"
              @submit="login"
            >
              <UFormField label="Email" name="email" required>
                <UInput
                  v-model="loginEmail"
                  type="email"
                  icon="i-lucide-mail"
                  placeholder="you@example.com"
                  class="w-full"
                  size="lg"
                  autocomplete="email"
                />
              </UFormField>
              <UFormField label="Password" name="password" required>
                <UInput
                  v-model="loginPassword"
                  type="password"
                  icon="i-lucide-lock"
                  class="w-full"
                  size="lg"
                  autocomplete="current-password"
                />
              </UFormField>
              <UAlert
                v-if="loginError"
                role="alert"
                icon="i-lucide-shield-alert"
                color="error"
                variant="subtle"
                :title="loginError"
              />
              <UButton type="submit" block size="lg" :loading="busy" label="Sign in" />
            </UForm>
            <UButton
              v-for="prov in authConfig.providers ?? []"
              :key="prov.id"
              block
              size="lg"
              variant="outline"
              icon="i-lucide-key-round"
              :label="`Sign in with ${prov.label}`"
              class="mt-3"
              @click="oidcLogin(prov.id, prov.label)"
            />
          </template>
        </UCard>
      </div>
    </div>

    <!-- ===================== APP (dashboard shell) ===================== -->
    <UDashboardGroup v-else unit="rem">
      <UDashboardSidebar id="tandem-sidebar" :min-size="14" :default-size="16" :max-size="22" collapsible resizable>
        <template #header="{ collapsed }">
          <NuxtLink
            to="/"
            class="focus-visible:ring-primary flex min-w-0 items-center gap-2.5 rounded-md outline-none focus-visible:ring-2"
          >
            <div class="bg-primary/10 flex size-9 shrink-0 items-center justify-center rounded-xl">
              <UIcon name="i-lucide-users" class="text-primary size-5" />
            </div>
            <div v-if="!collapsed" class="flex min-w-0 flex-col">
              <span class="text-highlighted truncate text-sm leading-tight font-semibold"
                >{{ companyName }}
                <span v-if="showVersionChip" class="text-dimmed text-xs font-normal">v{{ versionLabel }}</span>
              </span>
              <span class="text-dimmed truncate text-xs leading-tight">workspace</span>
            </div>
          </NuxtLink>
        </template>

        <UNavigationMenu :items="nav" orientation="vertical" class="px-2" />

        <template #footer="{ collapsed }">
          <div class="flex w-full items-center gap-2" :class="collapsed ? 'flex-col' : ''">
            <UAvatar :alt="session.user.name" size="xs" />
            <div v-if="!collapsed" class="min-w-0 flex-1">
              <!-- name, then the role as its own muted line only when it differs
                   from the name — 'Admin' + 'Admin' said it twice, and the raw
                   enum rode a middle-dot suffix before -->
              <p class="text-highlighted truncate text-xs font-medium">{{ session.user.name }}</p>
              <p v-if="showRoleSuffix" class="text-dimmed text-2xs truncate leading-tight">
                {{ roleLabel(session.user.role) }}
              </p>
            </div>
            <UButton
              icon="i-lucide-log-out"
              color="neutral"
              variant="ghost"
              size="sm"
              aria-label="Sign out"
              @click="logout"
            />
          </div>
        </template>
      </UDashboardSidebar>

      <slot />
    </UDashboardGroup>
  </div>
</template>
