<script setup lang="ts">
// Contextual workflow verbs for the task sidebar (owner rulings 2026-10-26):
// the composer posts plain notes and auto-becomes the answer box while the task
// waits for one; review verdicts live in the GitHub-style review box; Ask is an
// agent verb (envelope question), never a human button. Gated on the status
// CATEGORY, not hardcoded seeded ids — custom statuses in the working category
// get the same verbs.
import type { TaskRow, TaskStatusRow } from '~/utils/orpc-types';

defineProps<{
  busy: boolean;
  note: string;
  statusCategory: TaskStatusRow['category'] | null;
  assigneeKind?: TaskRow['assigneeKind'];
}>();

const emit = defineEmits<{ action: [action: SidebarWorkflowAction, extra: { body?: string }] }>();

type SidebarWorkflowAction = 'submit' | 'forward' | 'abandon';
</script>

<template>
  <div v-if="statusCategory === 'ready' || statusCategory === 'working' || statusCategory === 'paused'">
    <p class="mb-2 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">Workflow</p>
    <div class="grid grid-cols-2 gap-2">
      <!-- agents auto-submit via envelope; this verb is the human assignee's move -->
      <UButton
        v-if="assigneeKind !== 'ai'"
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
    </div>
  </div>
</template>
