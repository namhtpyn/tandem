<script setup lang="ts">
// Workflow action grid for the task sidebar (Ask/Forward/Answer/Approve/…).
// Presentational on purpose: the note is shared with the composer and the page
// owns wfAction + its $client.tasks.* calls, so busy/note come in as props and
// actions bubble up. dispatch/submit live in the composer.
type SidebarWorkflowAction =
  | 'ask'
  | 'forward'
  | 'answer'
  | 'approve'
  | 'requestChanges'
  | 'reject'
  | 'abandon';

defineProps<{ busy: boolean; note: string }>();

const emit = defineEmits<{ action: [action: SidebarWorkflowAction, extra: { body?: string }] }>();
</script>

<template>
  <div>
    <p class="mb-2 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">Workflow</p>
    <div class="grid grid-cols-2 gap-2">
      <UButton
        size="md"
        color="neutral"
        variant="outline"
        icon="i-lucide-help-circle"
        class="justify-start"
        :disabled="busy"
        @click="emit('action', 'ask', { body: note || 'question' })"
        >Ask</UButton
      >
      <UButton
        size="md"
        color="neutral"
        variant="outline"
        icon="i-lucide-corner-up-right"
        class="justify-start"
        :disabled="busy"
        @click="emit('action', 'forward', { body: note || undefined })"
        >Forward</UButton
      >
      <UButton
        size="md"
        color="neutral"
        variant="outline"
        icon="i-lucide-check-check"
        class="justify-start"
        :disabled="busy"
        @click="emit('action', 'answer', { body: note || 'answer' })"
        >Answer</UButton
      >
      <UButton
        size="md"
        color="success"
        variant="outline"
        icon="i-lucide-thumbs-up"
        class="justify-start"
        :disabled="busy"
        @click="emit('action', 'approve', { body: note || undefined })"
        >Approve</UButton
      >
      <UButton
        size="md"
        color="neutral"
        variant="outline"
        icon="i-lucide-undo-2"
        class="justify-start"
        :disabled="busy"
        @click="emit('action', 'requestChanges', { body: note || 'needs changes' })"
        >Request changes</UButton
      >
      <UButton
        size="md"
        color="error"
        variant="outline"
        icon="i-lucide-x-circle"
        class="justify-start"
        :disabled="busy"
        @click="emit('action', 'reject', { body: note || undefined })"
        >Reject</UButton
      >
      <UButton
        size="md"
        color="error"
        variant="outline"
        icon="i-lucide-ban"
        class="justify-start"
        :disabled="busy"
        @click="emit('action', 'abandon', { body: note || undefined })"
        >Abandon</UButton
      >
    </div>
  </div>
</template>
