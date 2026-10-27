<script setup lang="ts">
// Self-contained employee-title catalog manager: owns the titles query and the
// save/remove mutations plus the stacked list/editor/delete-confirm modals.
// The parent only toggles open.
import { useMutation, useQuery } from '@tanstack/vue-query';
import { computed, ref } from 'vue';

import { CHANGE_RESOURCE } from '#shared/enums';

const open = defineModel<boolean>('open', { default: false });

const { $orpc } = useNuxtApp();

const titlesQuery = useQuery(
  $orpc.employees.titles.list.queryOptions({ queryKey: [CHANGE_RESOURCE.EMPLOYEES, 'titles'] }),
);
const titles = computed(
  () =>
    (titlesQuery.data.value as { titles: Array<{ id: string; name: string; employees: number }> } | undefined)
      ?.titles ?? [],
);

const titleEditorOpen = ref(false);
const titleEditingId = ref<string | null>(null);
const titleForm = ref({ name: '' });
const titleBusy = ref(false);
const titleError = ref<string | null>(null);
const titleRemoveError = ref<string | null>(null);
const titleConfirmId = ref<string | null>(null);
const titleConfirming = computed(() => titles.value.find((t) => t.id === titleConfirmId.value) ?? null);

const titleSaveMutation = useMutation({ ...$orpc.employees.titles.save.mutationOptions() });
const titleRemoveMutation = useMutation({ ...$orpc.employees.titles.remove.mutationOptions() });

function openTitleEditor(id?: string) {
  titleError.value = null;
  titleEditingId.value = id ?? null;
  titleForm.value = { name: titles.value.find((t) => t.id === id)?.name ?? '' };
  titleEditorOpen.value = true;
}

async function saveTitle() {
  titleError.value = null;
  if (!titleForm.value.name.trim()) {
    titleError.value = 'Name is required';
    return;
  }
  titleBusy.value = true;
  try {
    await titleSaveMutation.mutateAsync({
      ...(titleEditingId.value ? { id: titleEditingId.value } : {}),
      name: titleForm.value.name.trim(),
    });
    titleEditorOpen.value = false;
  } catch (e) {
    titleError.value = e instanceof Error ? e.message : 'Save failed.';
  } finally {
    titleBusy.value = false;
  }
}

async function removeTitle(id: string) {
  titleRemoveError.value = null;
  titleBusy.value = true;
  try {
    await titleRemoveMutation.mutateAsync({ id });
    titleConfirmId.value = null;
  } catch (e) {
    titleRemoveError.value = e instanceof Error ? e.message : 'Delete failed.';
  } finally {
    titleBusy.value = false;
  }
}

onServerPrefetch(() => titlesQuery.suspense());
</script>

<template>
  <!-- titles manager (statuses-style) -->
  <UModal
    v-model:open="open"
    title="Employee titles"
    :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]', body: 'overflow-y-auto' }"
  >
    <template #body>
      <div v-if="titles.length" class="divide-default divide-y">
        <div v-for="t in titles" :key="t.id" class="flex items-center gap-2 py-2.5">
          <UBadge color="neutral" variant="subtle" icon="i-lucide-briefcase">{{ t.name }}</UBadge>
          <span class="text-muted text-xs">{{ t.employees }} {{ t.employees === 1 ? 'employee' : 'employees' }}</span>
          <span class="flex-1" />
          <UPopover mode="hover">
            <UButton
              icon="i-lucide-pencil"
              size="xs"
              color="neutral"
              variant="ghost"
              aria-label="Rename title"
              :disabled="titleBusy"
              @click="openTitleEditor(t.id)"
            />
            <template #content><div class="px-3 py-1.5 text-xs">Rename</div></template>
          </UPopover>
          <UPopover mode="hover">
            <UButton
              icon="i-lucide-trash-2"
              size="xs"
              color="neutral"
              variant="ghost"
              aria-label="Delete title"
              :disabled="titleBusy"
              @click="titleConfirmId = t.id"
            />
            <template #content><div class="px-3 py-1.5 text-xs">Delete</div></template>
          </UPopover>
        </div>
      </div>
      <p v-else class="text-muted py-6 text-center text-sm">No titles yet — create one to standardize roles.</p>
    </template>
    <template #footer>
      <div class="flex w-full items-center justify-between gap-2">
        <UButton icon="i-lucide-plus" size="sm" label="New title" @click="openTitleEditor()" />
      </div>
    </template>
  </UModal>

  <!-- title editor -->
  <UModal
    v-model:open="titleEditorOpen"
    :title="titleEditingId ? 'Rename title' : 'New title'"
    :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]', body: 'overflow-y-auto' }"
  >
    <template #body>
      <UFormField label="Name" name="name" required>
        <UInput
          v-model="titleForm.name"
          icon="i-lucide-briefcase"
          placeholder="e.g. Senior Engineer"
          class="w-full"
          :disabled="titleBusy"
        />
      </UFormField>
      <UAlert
        v-if="titleError"
        icon="i-lucide-circle-alert"
        color="error"
        variant="subtle"
        :title="titleError"
        class="mt-3"
        :ui="{ title: 'text-sm' }"
      />
      <p class="text-muted mt-2 text-xs">Renaming updates every employee who holds this title.</p>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton variant="ghost" color="neutral" @click="titleEditorOpen = false">Cancel</UButton>
        <UButton icon="i-lucide-check" :loading="titleBusy" @click="saveTitle">Save</UButton>
      </div>
    </template>
  </UModal>

  <!-- title delete confirm: employees keep their text -->
  <UModal
    :open="titleConfirmId !== null"
    @update:open="
      (v: boolean) => {
        if (!v) titleConfirmId = null;
      }
    "
    title="Delete title"
  >
    <template #body>
      <p class="text-sm">
        Delete <strong>{{ titleConfirming?.name }}</strong> from the catalog? Employees keep their title text — it just
        stops being offered in the picker.
      </p>
      <UAlert
        v-if="titleRemoveError"
        icon="i-lucide-circle-alert"
        color="error"
        variant="subtle"
        :title="titleRemoveError"
        class="mt-3"
        :ui="{ title: 'text-sm' }"
      />
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton variant="ghost" color="neutral" @click="titleConfirmId = null">Cancel</UButton>
        <UButton color="error" icon="i-lucide-trash-2" :loading="titleBusy" @click="removeTitle(titleConfirming!.id)"
          >Delete</UButton
        >
      </div>
    </template>
  </UModal>
</template>
