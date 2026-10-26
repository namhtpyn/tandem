<script setup lang="ts">
// GitHub-style review box: verdicts get their own input, not the chat composer
// (owner ruling 2026-10-26). Rendered on the task page while the task is in
// review; the note is optional and rides the verdict.
defineProps<{ busy: boolean }>();

const emit = defineEmits<{
  verdict: [action: 'approve' | 'requestChanges' | 'reject', body?: string];
}>();

const reviewNote = ref('');
</script>

<template>
  <div class="rounded-2xl border border-zinc-200 bg-white p-2.5 shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
    <p class="mb-1.5 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">Your review</p>
    <UTextarea
      v-model="reviewNote"
      :rows="1"
      autoresize
      :maxrows="6"
      variant="none"
      placeholder="Leave review feedback (optional)…"
      class="w-full"
      :ui="{ base: 'px-1 py-1 text-sm placeholder:text-zinc-400' }"
    />
    <div class="mt-1.5 flex items-center justify-end gap-1.5">
      <UButton
        size="md"
        color="error"
        variant="outline"
        icon="i-lucide-x-circle"
        :disabled="busy"
        @click="emit('verdict', 'reject', reviewNote)"
        >Reject</UButton
      >
      <UButton
        size="md"
        color="warning"
        variant="outline"
        icon="i-lucide-undo-2"
        :disabled="busy"
        @click="emit('verdict', 'requestChanges', reviewNote || 'needs changes')"
        >Request changes</UButton
      >
      <UButton
        size="md"
        color="success"
        icon="i-lucide-thumbs-up"
        :disabled="busy"
        @click="emit('verdict', 'approve', reviewNote || undefined)"
        >Approve</UButton
      >
    </div>
  </div>
</template>
