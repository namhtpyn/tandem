<script setup lang="ts">
import { attachmentUrl } from '~/utils/api-urls';
// Renders parsed task-text parts (the token grammar in utils/task-tokens) inside a
// message bubble: mentions as chips, images inline, non-images as file chips.
// Shared by the brief bubble and the run result bubble — one rendering of the
// grammar, so the run message's inlined screenshots look exactly like the brief's.
import type { TaskTextPart } from '~/utils/task-tokens';

defineProps<{ parts: TaskTextPart[] }>();
</script>

<template>
  <template v-for="(p, i) in parts" :key="i">
    <span
      v-if="p.type === 'mention'"
      class="bg-primary/10 text-primary mx-0.5 inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium"
      >@{{ p.label }}</span
    >
    <span v-else-if="p.type === 'text'" class="whitespace-pre-wrap">{{ p.body }}</span>
    <img
      v-else-if="p.type === 'image'"
      :src="attachmentUrl(p.id)"
      :alt="p.alt"
      class="border-default my-1.5 max-h-64 rounded-lg border"
    />
    <a
      v-else-if="p.type === 'file'"
      :href="attachmentUrl(p.id)"
      target="_blank"
      class="border-default bg-default text-toned hover:border-primary/50 hover:text-primary my-1 inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium"
      ><UIcon name="i-lucide-file-text" class="size-3.5 shrink-0" />{{ p.name }}</a
    >
  </template>
</template>
