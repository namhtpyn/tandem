<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query';
// Contextual workflow verbs ON the task page (#177, SPEC): one-click
// Submit/Cancel/Forward/Dispatch in the sidebar (desktop aside + mobile info
// sheet) — the /tasks workflow drawer is a second surface, never a required
// round-trip. Every verb renders ONLY where the server accepts it (the shared
// pure gates on the composable — same law as the drawer); the PAGE owns the
// verb ladder (useWorkflowActions) and this component only emits `action`.
// Self-loads employees for the forward picker (same pattern as
// TaskRoutingPanels). Props: task, statusCategory, agentRunning, note, busy,
// message/messageOk (the page's shared workflow feedback, echoed inline).
import { computed, ref, unref, watch } from 'vue';

import { CHANGE_RESOURCE } from '#shared/enums';
import type { Category } from '#shared/enums';
import { cancelReady, dispatchReady, forwardReady, submitReady } from '~/composables/useWorkflowActions';
import type { WorkflowAction, WorkflowExtra } from '~/composables/useWorkflowActions';
import type { EmployeeRow, TaskRow } from '~/utils/orpc-types';

const props = defineProps<{
  task: TaskRow;
  statusCategory: Category | null;
  agentRunning: boolean;
  note: string;
  busy: boolean;
  message: string;
  messageOk: boolean;
}>();

const emit = defineEmits<{ action: [action: WorkflowAction, extra?: WorkflowExtra] }>();

const { $orpc } = useNuxtApp();
const session = useAppSession();

// ---- the gates: shared pure helpers, null category = no verb at all ----
const userId = computed(() => session.value?.user.id ?? null);
const canSubmit = computed(() =>
  submitReady({
    category: props.statusCategory,
    assigneeId: props.task.assigneeId,
    assigneeKind: props.task.assigneeKind,
    userId: userId.value,
  }),
);
const canCancel = computed(() =>
  cancelReady({
    category: props.statusCategory,
    assigneeId: props.task.assigneeId,
    ownerId: props.task.ownerId,
    userId: userId.value,
  }),
);
const canDispatch = computed(() =>
  dispatchReady({ category: props.statusCategory, assigneeKind: props.task.assigneeKind, running: props.agentRunning }),
);
// forward is holder-scoped: waiting-answer + the viewer holds the obligation
const canForward = computed(() =>
  forwardReady({
    category: props.statusCategory,
    holderId: props.task.questionHolderId,
    userId: userId.value,
  }),
);

/** a verb block with zero verbs is noise, not a feature */
const anyVerb = computed(() => canSubmit.value || canCancel.value || canDispatch.value || canForward.value);

// ---- cancel: terminal → armed inline confirm instead of one-click fire ----
const cancelArmed = ref(false);
function confirmCancel() {
  cancelArmed.value = false;
  emit('action', 'abandon');
}

// ---- forward: picker over employees, holder excluded ----
const employeesLive = useQuery($orpc.employees.list.queryOptions({ queryKey: [CHANGE_RESOURCE.EMPLOYEES] }));
const employees = computed(() => (unref(employeesLive.data) ?? []) as EmployeeRow[]);
const forwardTo = ref(NONE_ID);
const forwardItems = computed(() =>
  employeeOptions(employees.value, { noneLabel: 'Not forwarded', excludeId: props.task.questionHolderId }),
);
function doForward() {
  if (!forwardTo.value || forwardTo.value === NONE_ID) return;
  const to = forwardTo.value;
  forwardTo.value = NONE_ID;
  emit('action', 'forward', { toEmployeeId: to, body: props.note });
}
// the obligation moved (forward landed or resolved elsewhere) → disarm
watch(canForward, (v) => {
  if (!v) forwardTo.value = NONE_ID;
});

function onSubmit() {
  emit('action', 'submit', { body: props.note });
}
function onDispatch() {
  emit('action', 'dispatch');
}
</script>

<template>
  <section v-if="anyVerb" class="space-y-2" data-testid="task-workflow-actions" aria-label="Workflow actions">
    <h3 class="text-muted text-xs font-medium">Workflow</h3>

    <div class="flex flex-wrap gap-2">
      <UButton
        v-if="canSubmit"
        size="sm"
        color="primary"
        variant="soft"
        icon="i-lucide-send"
        :disabled="busy"
        data-testid="task-verb-submit"
        @click="onSubmit()"
        >Submit for review</UButton
      >
      <UButton
        v-if="canCancel"
        size="sm"
        color="error"
        variant="soft"
        icon="i-lucide-ban"
        :disabled="busy"
        data-testid="task-verb-cancel"
        @click="cancelArmed = true"
        >Cancel task</UButton
      >
      <UButton
        v-if="canDispatch"
        size="sm"
        color="primary"
        variant="soft"
        icon="i-lucide-play"
        :disabled="busy"
        data-testid="task-verb-dispatch"
        @click="onDispatch()"
        >Dispatch now</UButton
      >
    </div>

    <template v-if="canForward">
      <USelect
        v-model="forwardTo"
        :items="forwardItems"
        value-key="value"
        size="sm"
        class="w-full"
        aria-label="Forward to"
      />
      <UButton
        size="sm"
        color="neutral"
        variant="soft"
        icon="i-lucide-corner-up-right"
        class="w-full"
        :disabled="busy || !forwardTo || forwardTo === NONE_ID"
        data-testid="task-verb-forward"
        @click="doForward()"
        >Forward</UButton
      >
    </template>

    <!-- cancelling is terminal: confirm it inline instead of firing on one click -->
    <div
      v-if="cancelArmed"
      class="border-error/40 bg-error/10 space-y-2 rounded-md border p-2.5 text-xs"
      role="alertdialog"
      aria-label="Confirm cancelling the task"
    >
      <p class="text-toned">Cancelling ends this task: the agent stops and it can no longer be dispatched.</p>
      <div class="flex gap-2">
        <UButton size="xs" color="error" label="Confirm cancel" :loading="busy" @click="confirmCancel()" />
        <UButton size="xs" color="neutral" variant="ghost" label="Keep it" @click="cancelArmed = false" />
      </div>
    </div>

    <!-- the page's shared workflow feedback, echoed where the verb was clicked
         (on mobile the composer footer sits behind the open info sheet) -->
    <p
      v-if="message"
      class="text-xs"
      :class="messageOk ? 'text-success' : 'text-error'"
      :role="messageOk ? 'status' : 'alert'"
      data-testid="task-verb-message"
    >
      {{ message }}
    </p>
  </section>
</template>
