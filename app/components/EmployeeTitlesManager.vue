<script setup lang="ts">
// Self-contained employee-title catalog manager: owns the titles query and the
// save/remove mutations plus the stacked list/editor/delete-confirm modals.
// The parent only toggles open.
import { useMutation, useQuery } from '@tanstack/vue-query';
import { computed, ref } from 'vue';
import { z } from 'zod';

import { CHANGE_RESOURCE } from '#shared/enums';
import { saveFailed } from '~/utils/forms';
import type { TitleRow } from '~/utils/orpc-types';

const open = defineModel<boolean>('open', { default: false });

const { $orpc } = useNuxtApp();

const titlesQuery = useQuery(
  $orpc.employees.titles.list.queryOptions({ queryKey: [CHANGE_RESOURCE.EMPLOYEES, 'titles'] }),
);
const titles = computed<TitleRow[]>(() => titlesQuery.data.value?.titles ?? []);

const titleEditorOpen = ref(false);
const titleEditingId = ref<string | null>(null);
const titleForm = ref({ name: '' });
// loose frontend schema (repo law): name presence only
const titleSchema = z.object({ name: z.string().min(1, 'Name is required') });
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
  // one write at a time — a double-click or stray Enter must not double-create
  if (titleBusy.value) return;
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
    titleError.value = saveFailed(e, 'title');
  } finally {
    titleBusy.value = false;
  }
}

function askRemoveTitle(id: string) {
  titleRemoveError.value = null;
  titleConfirmId.value = id;
}

async function removeTitle(id: string) {
  titleRemoveError.value = null;
  titleBusy.value = true;
  try {
    await titleRemoveMutation.mutateAsync({ id });
    titleConfirmId.value = null;
  } catch (e) {
    titleRemoveError.value = saveFailed(e, 'title', 'delete');
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
        <div v-for="t in titles" :key="t.id" class="group flex items-center gap-2 py-2.5">
          <UBadge color="neutral" variant="subtle" icon="i-lucide-briefcase">{{ t.name }}</UBadge>
          <span class="text-muted text-xs">{{ t.employees }} {{ t.employees === 1 ? 'employee' : 'employees' }}</span>
          <span
            class="flex-1 transition-opacity md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
          />
          <div
            class="flex gap-1 transition-opacity md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
          >
            <UPopover mode="hover" enable-touch>
              <UButton
                icon="i-lucide-pencil"
                size="sm"
                color="neutral"
                variant="ghost"
                :aria-label="`Rename ${t.name}`"
                :disabled="titleBusy"
                @click="openTitleEditor(t.id)"
              />
              <template #content><div class="px-3 py-1.5 text-xs">Rename</div></template>
            </UPopover>
            <UPopover mode="hover" enable-touch>
              <UButton
                icon="i-lucide-trash-2"
                size="sm"
                color="neutral"
                variant="ghost"
                class="text-muted hover:text-error"
                :aria-label="`Delete ${t.name}`"
                :disabled="titleBusy"
                @click="askRemoveTitle(t.id)"
              />
              <template #content><div class="px-3 py-1.5 text-xs">Delete</div></template>
            </UPopover>
          </div>
        </div>
      </div>
      <div v-else-if="titlesQuery.isPending.value" class="space-y-2 py-4" aria-hidden="true">
        <USkeleton class="h-10 w-full rounded-lg" />
        <USkeleton class="h-10 w-2/3 rounded-lg" />
      </div>
      <p v-else-if="titlesQuery.isError.value" role="alert" class="text-error py-10 text-center text-sm">
        Couldn't load titles
      </p>
      <div v-else class="flex flex-col items-center gap-3 py-10 text-center">
        <UIcon name="i-lucide-briefcase" class="text-toned size-10" aria-hidden="true" />
        <div>
          <p class="text-highlighted text-sm font-medium">No titles yet</p>
          <p class="text-muted mt-1 text-xs">Create one to standardize roles across employees.</p>
        </div>
        <UButton icon="i-lucide-plus" label="New title" size="sm" @click="openTitleEditor()" />
      </div>
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
      <UForm id="title-editor-form" :schema="titleSchema" :state="titleForm" @submit="saveTitle">
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
          role="alert"
          icon="i-lucide-circle-alert"
          color="error"
          variant="subtle"
          :title="titleError"
          class="mt-3"
          :ui="{ title: 'text-sm' }"
        />
        <!-- rename-specific: creating a title has nothing to rename yet -->
        <p v-if="titleEditingId" class="text-muted mt-2 text-xs">
          Renaming updates every employee who holds this title.
        </p>
      </UForm>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton variant="ghost" color="neutral" @click="titleEditorOpen = false">Cancel</UButton>
        <UButton
          type="submit"
          form="title-editor-form"
          icon="i-lucide-check"
          :loading="titleBusy"
          :label="titleEditingId ? 'Save changes' : 'Create title'"
        />
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
        role="alert"
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
        <UButton
          color="error"
          icon="i-lucide-trash-2"
          :loading="titleBusy"
          @click="titleConfirming && removeTitle(titleConfirming.id)"
          >Delete</UButton
        >
      </div>
    </template>
  </UModal>
</template>
