<script setup lang="ts">
// Contextual workflow verbs for the task sidebar: only the moves the task's
// current state makes meaningful are rendered (owner law 2026-10-26 — the
// composer posts plain notes; state transitions surface per state).
// Presentational: the page owns wfAction + its $client.tasks.* calls.
import type { TaskRow } from '~/utils/orpc-types';
import { STATUS } from '#shared/status';

type SidebarWorkflowAction =
  | 'submit'
  | 'ask'
  | 'forward'
  | 'answer'
  | 'approve'
  | 'requestChanges'
  | 'reject'
  | 'abandon';

defineProps<{ busy: boolean; note: string; statusId: TaskRow['status'] }>();

const emit = defineEmits<{ action: [action: SidebarWorkflowAction, extra: { body?: string }] }>();

// string[] on purpose: TaskRow.status is a plain id, no literal narrowing needed
const working: string[] = [STATUS.todo, STATUS.doing, STATUS.blocked];
</script>

<template>
  <div v-if="statusId !== STATUS.done && statusId !== STATUS.cancelled">
    <p class="mb-2 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">Workflow</p>
    <div class="grid grid-cols-2 gap-2">
      <!-- waiting for an answer: the only meaningful move is answering -->
      <UButton
        v-if="statusId === STATUS.waitingAnswer"
        size="md"
        color="primary"
        variant="outline"
        icon="i-lucide-check-check"
        class="justify-start"
        :disabled="busy"
        @click="emit('action', 'answer', { body: note || 'answer' })"
        >Answer</UButton
      >
      <template v-else-if="statusId === STATUS.inReview">
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
      </template>
      <template v-else-if="working.includes(statusId)">
        <!-- the assignee's move: hand the work to review -->
        <UButton
          size="md"
          color="primary"
          variant="outline"
          icon="i-lucide-arrow-right-circle"
          class="justify-start"
          :disabled="busy"
          @click="emit('action', 'submit', { body: note || undefined })"
          >Submit for review</UButton
        >
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
          color="error"
          variant="outline"
          icon="i-lucide-ban"
          class="justify-start"
          :disabled="busy"
          @click="emit('action', 'abandon', { body: note || undefined })"
          >Abandon</UButton
        >
      </template>
    </div>
  </div>
</template>
