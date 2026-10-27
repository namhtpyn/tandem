<script setup lang="ts">
// GitHub-style review box: verdicts get their own input, not the chat composer
// (owner ruling 2026-10-26). Rendered only for explicit reviewers while the task
// is in review. The note is optional for approve, REQUIRED for request changes
// (no fabricated "needs changes"), and reject is terminal — two-click confirm.
defineProps<{ busy: boolean }>();

const emit = defineEmits<{
  verdict: [action: 'approve' | 'requestChanges' | 'reject', body?: string];
}>();

const reviewNote = ref('');

// reject ends the task — first click arms for 3s, the second one fires
const rejectArmed = ref(false);
let rejectTimer: ReturnType<typeof setTimeout> | null = null;

function disarmReject() {
  rejectArmed.value = false;
  if (rejectTimer) clearTimeout(rejectTimer);
  rejectTimer = null;
}

function onRejectClick() {
  if (!rejectArmed.value) {
    rejectArmed.value = true;
    if (rejectTimer) clearTimeout(rejectTimer);
    rejectTimer = setTimeout(disarmReject, 3000);
    return;
  }
  disarmReject();
  emit('verdict', 'reject', reviewNote.value || undefined);
}

onUnmounted(disarmReject);
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
      placeholder="Leave review feedback (required to request changes)…"
      class="w-full"
      :ui="{ base: 'px-1 py-1 text-sm placeholder:text-zinc-400' }"
    />
    <div class="mt-1.5 flex items-center justify-end gap-1.5">
      <UButton
        size="md"
        color="error"
        :variant="rejectArmed ? 'solid' : 'outline'"
        icon="i-lucide-x-circle"
        :disabled="busy"
        @click="onRejectClick"
        >{{ rejectArmed ? 'Confirm reject?' : 'Reject' }}</UButton
      >
      <UButton
        size="md"
        color="warning"
        variant="outline"
        icon="i-lucide-undo-2"
        :disabled="busy || !reviewNote.trim()"
        @click="emit('verdict', 'requestChanges', reviewNote)"
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
