<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
// Task create/edit editor modal: tiptap description with paste/drop image
// attachments, @mention menu, assignee/status/project/owner/reviewers fields.
// Self-loads statuses/employees/projects (vue-query dedupes with the manager's
// display queries). Props: v-model:open + `task` (null = create). Emits
// `saved` after a successful create/update.
import type { Editor } from '@tiptap/core';
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { computed, reactive, ref, watch } from 'vue';
import { z } from 'zod';

import { CATEGORY, CHANGE_RESOURCE } from '#shared/enums';
import { STATUS } from '#shared/status';
import type { EditorView, ClipboardEventLike, DragEventLike } from '~/types/editor-typing';
import { taskAttachmentsUrl } from '~/utils/api-urls';
import { NONE_ID, saveFailed } from '~/utils/forms';
import type { EmployeeRow, TaskRow } from '~/utils/orpc-types';
import { attachmentRef, attachmentToken } from '~/utils/task-tokens';
import { employeeOptions, kindLabel } from '~/utils/ui-labels';

const open = defineModel<boolean>('open', { default: false });
const props = defineProps<{ task: TaskRow | null; parentTaskId?: string | null }>();
const emit = defineEmits<{ saved: [] }>();

const { $orpc, $client } = useNuxtApp();
const queryClient = useQueryClient();

// self-load: statuses (first-status default + editor select), employees
// (mention items + pickers), projects (picker)
const statusesLive = useQuery($orpc.statuses.list.queryOptions({ queryKey: [CHANGE_RESOURCE.STATUSES] }));
const employeesLive = useQuery($orpc.employees.list.queryOptions({ queryKey: [CHANGE_RESOURCE.EMPLOYEES] }));
const projectsLive = useQuery($orpc.projects.list.queryOptions({ queryKey: [CHANGE_RESOURCE.PROJECTS] }));
const statuses = computed(() => unref(statusesLive.data) ?? []);
// the create-time status select lists READY-category statuses only — default to
// the first of those so the select never renders with a value it can't display
const defaultStatusId = computed(() => statuses.value.find((x) => x.category === CATEGORY.READY)?.id ?? STATUS.todo);
const employees = computed(() => (unref(employeesLive.data) ?? []) as EmployeeRow[]);
// @mention menu items: label = display name, mention id = employee id (used by the brief builder)
const mentionItems = computed(() =>
  employees.value.map((e) => ({
    label: e.name,
    id: e.id,
    description: e.title ?? kindLabel(e.kind),
  })),
);
const projectRows = computed(() => (unref(projectsLive.data) ?? []) as Array<{ id: string; name: string }>);

const descriptionEditor = ref<Editor | null>(null);
function captureDescriptionEditor(e: Editor): string {
  if (descriptionEditor.value !== e) descriptionEditor.value = e;
  return '';
}

/** paste/drop images in the description editor -> attachments pipeline.
 *  Bytes NEVER ride ACP: upload lands them in /api/tasks/:id/attachments, the
 *  description keeps its ![](attachment-<id>) markdown ref, and dispatch stages
 *  the file to the agent host over the SFTP mirror like any other attachment.
 *  (the bundled UEditor Image extension parses/serializes the marker refs) */
const ImagePaste = Extension.create<{ onImage: (file: File) => Promise<void> }>({
  name: 'tandemImagePaste',
  addOptions() {
    return { onImage: async () => {} };
  },
  addProseMirrorPlugins() {
    const onImage = this.options.onImage;
    const grab = (files: FileList | null | undefined): boolean => {
      const imgs = files ? Array.from(files).filter((f) => f.type.startsWith('image/')) : [];
      if (!imgs.length) return false;
      for (const f of imgs) void onImage(f);
      return true;
    };
    return [
      new Plugin({
        name: new PluginKey('tandemImagePaste'),
        props: {
          handlePaste: (_view: EditorView, event: ClipboardEventLike) => grab(event.clipboardData?.files),
          handleDrop: (_view: EditorView, event: DragEventLike, _slice: unknown, moved: boolean) =>
            !moved && grab(event.dataTransfer?.files),
        },
      }),
    ];
  },
});

const attachmentInput = ref<HTMLInputElement | null>(null);
const editingId = ref<string | null>(null);
// busy = ANY write in flight. Uploads and save are counted separately: a
// finished upload must not re-enable Save while another upload (or the save
// itself) is still running.
const saving = ref(false);
const uploadCount = ref(0);
const busy = computed(() => saving.value || uploadCount.value > 0);
/** uploads run one at a time behind this chain — two paste events racing the
 *  same title would otherwise each mint their own task/draft row */
let uploadChain: Promise<unknown> = Promise.resolve();
const message = ref('');
const messageOk = ref(false); // tone: success paths ('Attached …') render green

const form = reactive({
  title: '',
  description: '',
  assigneeId: NONE_ID as string,
  status: STATUS.todo as string,
  projectId: NONE_ID as string,
  reviewers: [] as string[],
});
const isEdit = computed(() => editingId.value !== null);

// (re)populate from the row every time the modal opens
watch(open, (v) => {
  if (!v) {
    // closing unsaved must not leave an attachment-only draft in the list
    void discardDraft();
    return;
  }
  const row = props.task;
  editingId.value = row?.id ?? null;
  createdInSession.value = false;
  draftStatus.value = null;
  form.title = row?.title ?? '';
  // SNAPSHOT-SLIMMING LAW (#130 slice 3): list rows no longer carry the body —
  // it lands below via the on-open getDescription fetch
  form.description = '';
  form.assigneeId = row?.assigneeId ?? NONE_ID;
  form.projectId = row?.projectId ?? NONE_ID;
  form.reviewers = row?.reviewers ? [...row.reviewers] : [];
  form.status = row?.status ?? defaultStatusId.value;
  message.value = '';
  void fetchOpenDescription();
});

/** SNAPSHOT-SLIMMING LAW (#130 slice 3): the description body fetches on open —
 * one-shot imperative GET via $client (same surface as runTranscript in
 * TaskActivityThread). Clobber guard: apply only while the field still holds
 * its open-time value ('') — user typing (or a queued attachment append) since
 * open keeps their content and skips the fetched body entirely; reopening
 * re-fetches. */
async function fetchOpenDescription() {
  const taskId = editingId.value;
  if (!taskId) return;
  try {
    const full = await $client.tasks.getDescription({ taskId });
    // closed, or re-opened on a different row meanwhile → this fetch is stale
    if (!open.value || editingId.value !== taskId) return;
    if (form.description === '') form.description = full.description;
  } catch {
    /* unknown/gone task — the field stays empty and editable */
  }
}

// ---- attachment-first creates ------------------------------------------------
// An image paste needs a task row to hang the upload on, so the first upload
// creates one. A multi-image paste fires all the uploads at once: ONE shared
// promise is what stops each of them minting its own task.
let createInFlight: Promise<string> | null = null;
/** true when this modal created the row itself — close-without-save deletes it */
const createdInSession = ref(false);
/** status the draft was created with (the edit form no longer carries it) */
const draftStatus = ref<string | null>(null);

async function ensureTaskId(): Promise<string> {
  if (editingId.value) return editingId.value;
  if (!createInFlight) {
    const created = (async () => {
      const row = await $client.tasks.create({
        title: form.title.trim(),
        description: '',
        assigneeId: form.assigneeId === NONE_ID ? null : form.assigneeId,
        status: form.status,
        projectId: form.projectId === NONE_ID ? null : form.projectId,
        // a subtask's attachment-first create must not orphan it at the top level
        parentId: props.parentTaskId ?? undefined,
      });
      createdInSession.value = true;
      draftStatus.value = form.status;
      editingId.value = row.id;
      void queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.TASKS] });
      return row.id;
    })();
    const tracked: Promise<string> = created.finally(() => {
      if (createInFlight === tracked) createInFlight = null;
    });
    createInFlight = tracked;
  }
  return createInFlight;
}

/** delete the attachment-only draft when the modal closes without saving */
async function discardDraft() {
  // an attachment paste can still be minting the row: wait for it, or close
  // would leave the draft orphaned in the list (and editingId would still be null)
  if (createInFlight) {
    try {
      await createInFlight;
    } catch {
      /* the upload surfaced its own failure */
    }
  }
  // reopened while we waited: the new session owns the row now
  if (open.value) return;
  const id = editingId.value;
  const draft = createdInSession.value;
  createdInSession.value = false;
  draftStatus.value = null;
  if (!draft || !id) return;
  try {
    await $client.tasks.remove({ id });
    void queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.TASKS] });
  } catch {
    /* already gone — nothing to clean up */
  }
}

/** upload response contract — the server owns it; a silent shape drift must fail
 *  loudly here instead of building a broken attachment token */
const uploadResponseSchema = z.object({ id: z.string().min(1), filename: z.string().min(1), mime: z.string().min(1) });

/** queue + upload one file; the insertion itself is serialized so two pastes
 *  can never race ensureTaskId or interleave their description appends */
function uploadAttachment(
  file: File,
  viaEditor = false,
): Promise<{ id: string; filename: string; token: string } | null> {
  const job = uploadChain.then(() => uploadOne(file, viaEditor));
  uploadChain = job.catch(() => undefined);
  return job;
}

async function uploadOne(
  file: File,
  viaEditor: boolean,
): Promise<{ id: string; filename: string; token: string } | null> {
  if (!form.title.trim()) {
    messageOk.value = false;
    message.value = 'Add a title first — files attach to a saved task';
    return null;
  }
  uploadCount.value += 1;
  try {
    const taskId = await ensureTaskId();
    const fd = new FormData();
    fd.append('file', file);
    const up = uploadResponseSchema.parse(await $fetch(taskAttachmentsUrl(taskId), { method: 'POST', body: fd }));
    const token = attachmentToken(up.mime, up.filename, up.id);
    // when the editor owns the field the image NODE is the single insertion —
    // appending the string too would duplicate the marker in the doc
    if (!viaEditor) form.description = form.description ? `${form.description}\n${token}` : token;
    messageOk.value = true;
    message.value = `Attached ${up.filename}`;
    return { id: up.id, filename: up.filename, token };
  } catch (e) {
    messageOk.value = false;
    message.value = errorMessage(e, "Couldn't attach the file — try again");
  } finally {
    uploadCount.value -= 1;
  }
  return null;
}

/** in-editor paste/drop (and the paperclip): upload then insert an image
 *  NODE at the cursor — serializes back to the attachment marker in v-model */
async function onEditorImage(file: File) {
  const att = await uploadAttachment(file, true);
  if (!att) return;
  if (descriptionEditor.value) {
    descriptionEditor.value.commands.insertContent({
      type: 'image',
      attrs: { src: attachmentRef(att.id), alt: att.filename },
    });
  } else {
    // editor not mounted (defensive) — fall back to the string append
    form.description = form.description ? `${form.description}\n${att.token}` : att.token;
  }
}

/** STABLE identity: an inline `:extensions="[...]"` re-creates the array every
 *  render (message.value, title typing, ...) — UEditor re-initializes on the
 *  new array and its reset emit clobbers the description to ''. Built once. */
const descriptionExtensions = [ImagePaste.configure({ onImage: onEditorImage })];

function onAttachmentPicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) void onEditorImage(file);
  input.value = '';
}

const createMutation = useMutation($orpc.tasks.create.mutationOptions());
const updateMutation = useMutation($orpc.tasks.update.mutationOptions());

// loose frontend schema (repo law): title presence only — the server owns the rest
const taskFormSchema = z.object({ title: z.string().trim().min(1, 'Title is required') });

const assigneeOptions = computed(() => employeeOptions(employees.value, { noneLabel: 'Unassigned' }));
const reviewerOptions = computed(() => employeeOptions(employees.value));
const projectOptions = computed(() => [
  { label: 'No project', value: NONE_ID },
  ...projectRows.value.map((p) => ({ label: p.name, value: p.id })),
]);
const statusOptions = computed(() =>
  statuses.value.filter((x) => x.category === CATEGORY.READY).map((x) => ({ label: x.name, value: x.id })),
);

/** parent name for the subtask submit copy ('Adding to <parent>') */
const parentTaskQuery = useQuery({
  ...$orpc.tasks.list.queryOptions({ queryKey: [CHANGE_RESOURCE.TASKS] }),
  enabled: !!props.parentTaskId,
});
const parentTitle = computed(() => {
  if (!props.parentTaskId) return '';
  const rows = (unref(parentTaskQuery.data) ?? []) as TaskRow[];
  return rows.find((t) => t.id === props.parentTaskId)?.title ?? 'the parent task';
});

/** a live review round owns the reviewer list — editing it would strand live
 *  checklists that never sum to a decision (the server rejects the write too) */
const reviewersLocked = computed(() => {
  const statusId = createdInSession.value ? form.status : isEdit.value ? props.task?.status : null;
  return (statuses.value.find((s) => s.id === statusId)?.category ?? null) === CATEGORY.IN_REVIEW;
});

async function save() {
  // one write at a time — a double-click or stray Enter must not double-create
  if (saving.value) return;
  saving.value = true;
  message.value = '';
  try {
    // an attachment paste may be minting the task right now — saving in parallel
    // would take the create branch too and mint a SECOND task for the same form
    if (createInFlight) {
      try {
        await createInFlight;
      } catch {
        /* that upload reported the failure; this save can still create cleanly */
      }
    }
    // tokens land in the description as their uploads finish — save the doc the
    // user can actually see, after the queued uploads appended theirs
    if (uploadCount.value > 0) await uploadChain;
    const payload = {
      title: form.title.trim(),
      // prefer the live doc's markdown; the string form.description is the
      // fallback (defensive against editor remounts)
      description: (descriptionEditor.value?.getMarkdown() ?? '').trim() || form.description,
      assigneeId: form.assigneeId === NONE_ID ? null : form.assigneeId,
      projectId: form.projectId === NONE_ID ? null : form.projectId,
      reviewers: form.reviewers,
    };
    if (editingId.value) {
      // a draft created for an attachment kept the status chosen at create time;
      // the edit path never resends it, so a late change would silently vanish
      if (createdInSession.value && draftStatus.value && form.status !== draftStatus.value) {
        await $client.tasks.setStatus({ id: editingId.value, status: form.status });
        draftStatus.value = form.status;
      }
      await updateMutation.mutateAsync({ id: editingId.value, ...payload });
    } else {
      await createMutation.mutateAsync({
        ...payload,
        status: form.status,
        ...(props.parentTaskId ? { parentId: props.parentTaskId } : {}),
      });
    }
    // saved (not discarded): the close watcher must leave the row alone
    createdInSession.value = false;
    draftStatus.value = null;
    open.value = false;
    emit('saved');
  } catch (e) {
    messageOk.value = false;
    message.value = saveFailed(e, 'task');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="isEdit ? 'Edit task' : parentTaskId ? 'New subtask' : 'New task'"
    :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]', body: 'overflow-y-auto' }"
  >
    <template #body>
      <UForm id="task-editor-form" :schema="taskFormSchema" :state="form" class="space-y-4" @submit="save">
        <UFormField label="Title" name="title" required>
          <template #hint><FormHint text="Short summary of the work" /></template>
          <UInput v-model="form.title" icon="i-lucide-list-todo" placeholder="Task title" class="w-full" />
        </UFormField>
        <UFormField label="Description" name="description">
          <template #hint
            ><FormHint
              text="Paste or drop images to attach. Type @ to mention an employee; AI agents receive this as their instructions."
          /></template>
          <input
            ref="attachmentInput"
            type="file"
            class="hidden"
            accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.txt,.md,.csv,.json,.zip"
            @change="onAttachmentPicked"
          />
          <UEditor
            v-slot="{ editor }"
            v-model="form.description"
            :extensions="descriptionExtensions"
            content-type="markdown"
            placeholder="What needs to be done"
            class="bg-default ring-accented focus-visible:ring-primary min-h-18 w-full rounded-md px-2.5 py-1.5 ring ring-inset"
            :ui="{ base: 'px-0 sm:px-0' }"
          >
            <span class="hidden">{{ captureDescriptionEditor(editor) }}</span>
            <UEditorMentionMenu :editor="editor" :items="mentionItems" />
          </UEditor>
          <!-- attach lives in the editor toolbar row (not the label) so it reads
               as part of the description field, not a stray label icon -->
          <div class="mt-1 flex items-center">
            <UButton
              size="xs"
              class="min-h-8"
              color="neutral"
              variant="ghost"
              icon="i-lucide-paperclip"
              label="Attach"
              :disabled="busy || !form.title.trim()"
              @click="attachmentInput?.click()"
            />
          </div>
        </UFormField>
        <UFormField label="Project" name="projectId">
          <template #hint><FormHint text="Group this task under a project" /></template>
          <USelectMenu
            v-model="form.projectId"
            :items="projectOptions"
            value-key="value"
            :search-input="{ placeholder: 'Search projects' }"
            icon="i-lucide-folder-kanban"
            placeholder="No project"
            class="w-full"
          />
        </UFormField>
        <UFormField label="Assignee" name="assigneeId">
          <template #hint><FormHint text="Human or AI agent responsible" /></template>
          <USelect
            v-model="form.assigneeId"
            :items="assigneeOptions"
            value-key="value"
            icon="i-lucide-user-check"
            class="w-full"
          />
        </UFormField>
        <UFormField v-show="!isEdit || createdInSession" label="Status" name="status">
          <USelect
            v-model="form.status"
            :items="statusOptions"
            value-key="value"
            icon="i-lucide-circle-dot"
            class="w-full"
          />
        </UFormField>
        <!-- owner/reviewers sit OUTSIDE the status field's slot: the status field
             is hidden in edit mode, and routing fields must render in both modes -->
        <UFormField label="Reviewers" name="reviewers">
          <USelectMenu
            v-model="form.reviewers"
            multiple
            :items="reviewerOptions"
            value-key="value"
            icon="i-lucide-user-check"
            :disabled="reviewersLocked"
            :placeholder="reviewersLocked ? 'Locked while a review round is live' : 'Add reviewers…'"
            class="w-full"
          />
          <!-- unanimous policy under the field, not crammed into the label -->
          <template #description>
            <p class="text-muted text-xs">
              All reviewers must approve before the task completes — leave empty to complete without review.
            </p>
          </template>
        </UFormField>
        <p
          v-if="message"
          :class="messageOk ? 'text-success' : 'text-error'"
          class="text-sm"
          :role="messageOk ? 'status' : 'alert'"
        >
          {{ message }}
        </p>
      </UForm>
    </template>
    <template #footer>
      <div class="flex w-full items-center justify-end gap-2">
        <p v-if="!isEdit && parentTaskId" class="text-muted mr-auto truncate text-xs">Adding to {{ parentTitle }}</p>
        <UButton variant="ghost" color="neutral" label="Cancel" :disabled="busy" @click="open = false" />
        <UButton
          type="submit"
          :loading="busy"
          :label="isEdit ? 'Save changes' : parentTaskId ? 'Create subtask' : 'Create task'"
          form="task-editor-form"
        />
      </div>
    </template>
  </UModal>
</template>

<style scoped>
/* attachment marker images inside the description editor: src is the protocol
   marker (attachment-<id>), not a URL — render as a tidy chip instead of the
   browser's broken-image glyph. The real image renders in the task thread. */
:deep(.ProseMirror img[src^='attachment-']) {
  display: inline-block;
  min-height: 1.75em;
  padding: 0.15rem 0.5rem;
  border-radius: 0.375rem;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-muted);
  color: var(--ui-text-muted);
  font-size: 0.75rem;
  line-height: 1.5;
  object-fit: contain;
  vertical-align: middle;
}
</style>
