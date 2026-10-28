<script setup lang="ts">
// GitHub-style review box: verdicts get their own input, not the chat composer
// (owner ruling 2026-10-26). Rendered only for explicit reviewers while the task
// is in review. The note is optional for approve, REQUIRED for request changes
// (no fabricated "needs changes"), and reject is terminal — two-click confirm.
const props = defineProps<{ busy: boolean; verdictSeq: number; verdictFailed?: boolean }>();

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

// the parent settles the VERDICT (a verdict-specific sequence, never the shared
// busy flag — a composer send or upload finishing must not wipe this note): a
// FAILED verdict keeps the note (retry needs it) and disarms a stale reject
// confirm; a landed one clears the note
watch(
  () => props.verdictSeq,
  () => {
    if (props.verdictFailed) disarmReject();
    else reviewNote.value = '';
  },
);

onUnmounted(disarmReject);
</script>

<template>
  <div class="border-default bg-default rounded-2xl border p-2.5 shadow-sm">
    <h2 class="text-muted mb-1.5 text-xs font-medium">Your review</h2>
    <UTextarea
      v-model="reviewNote"
      :rows="1"
      autoresize
      :maxrows="6"
      variant="none"
      :disabled="busy"
      placeholder="Leave review feedback (required to request changes)…"
      aria-label="Review note"
      class="w-full"
      :ui="{ base: 'px-1 py-1 text-sm placeholder:text-dimmed' }"
    />
    <!-- wrap + stack: three md verdict buttons overflow every phone width, so
         below sm they stack full-width (Approve on top, Reject bottom). DOM order
         IS the mobile visual order (keyboard focus agrees with it); on desktop
         sm:flex-row-reverse mirrors it back to the familiar Reject→Approve line. -->
    <div
      class="mt-1.5 flex flex-col items-stretch gap-1.5 sm:flex-row-reverse sm:flex-wrap sm:items-center sm:justify-end"
    >
      <UButton
        size="md"
        color="success"
        icon="i-lucide-thumbs-up"
        :disabled="busy"
        @click="emit('verdict', 'approve', reviewNote || undefined)"
        >Approve</UButton
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
        color="error"
        :variant="rejectArmed ? 'solid' : 'outline'"
        icon="i-lucide-x-circle"
        :disabled="busy"
        @click="onRejectClick"
        ><span aria-live="polite">{{ rejectArmed ? 'Click again to confirm' : 'Reject' }}</span></UButton
      >
    </div>
  </div>
</template>
