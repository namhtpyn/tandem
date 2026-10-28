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

import { CHANGE_RESOURCE } from '#shared/enums';
import { STATUS } from '#shared/status';
import type { EditorView, ClipboardEventLike, DragEventLike } from '~/types/editor-typing';
import { NONE_ID, errorMessage } from '~/utils/forms';
import type { EmployeeRow, TaskRow } from '~/utils/orpc-types';
import { kindLabel } from '~/utils/ui-labels';

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
const defaultStatusId = computed(() => statuses.value.find((x) => x.category === 'ready')?.id ?? STATUS.todo);
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

/** paste/drop images in the description editor -> attachments pipeline.
 *  Bytes NEVER ride ACP: upload lands them in /api/tasks/:id/attachments, the
 *  description keeps its ![](attachment-<id>) markdown ref, and dispatch stages
 *  the file to the agent host over the SFTP mirror like any other attachment. */
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
const busy = ref(false);
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
  if (!v) return;
  const row = props.task;
  editingId.value = row?.id ?? null;
  form.title = row?.title ?? '';
  form.description = row?.description ?? '';
  form.assigneeId = row?.assigneeId ?? NONE_ID;
  form.projectId = row?.projectId ?? NONE_ID;
  form.reviewers = row?.reviewers ? [...row.reviewers] : [];
  form.status = row?.status ?? defaultStatusId.value;
  message.value = '';
});

/** upload a file to the task being created/edited and insert its token into the description */
async function uploadAttachment(
  file: File,
  viaEditor = false,
): Promise<{ id: string; filename: string; token: string } | null> {
  if (!form.title.trim()) {
    messageOk.value = false;
    message.value = 'Add a title first — files attach to a saved task';
    return null;
  }
  try {
    busy.value = true;
    let taskId = editingId.value;
    if (!taskId) {
      // create the task first so the attachment has a row to belong to
      const created = await $client.tasks.create({
        title: form.title,
        description: '',
        assigneeId: form.assigneeId === NONE_ID ? null : form.assigneeId,
        status: form.status,
        projectId: form.projectId === NONE_ID ? null : form.projectId,
      });
      taskId = created.id;
      editingId.value = taskId;
      // the row exists the moment the attachment uploads — refresh the lists
      void queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.TASKS] });
    }
    const fd = new FormData();
    fd.append('file', file);
    const up = (await $fetch(`/api/tasks/${taskId}/attachments`, { method: 'POST', body: fd })) as {
      id: string;
      filename: string;
      mime: string;
    };
    const token = up.mime.startsWith('image/')
      ? `![${up.filename}](attachment-${up.id})`
      : `@[${up.filename}](attachment-${up.id})`;
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
    busy.value = false;
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
      attrs: { src: `attachment-${att.id}`, alt: att.filename },
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

const assigneeOptions = computed(() => [
  { label: 'Unassigned', value: NONE_ID },
  ...employees.value.map((e) => ({ label: `${e.name}${e.kind === 'ai' ? ' (AI)' : ''}`, value: e.id })),
]);
const projectOptions = computed(() => [
  { label: 'No project', value: NONE_ID },
  ...projectRows.value.map((p) => ({ label: p.name, value: p.id })),
]);
const statusOptions = computed(() =>
  statuses.value.filter((x) => x.category === 'ready').map((x) => ({ label: x.name, value: x.id })),
);

async function save() {
  busy.value = true;
  message.value = '';
  try {
    const payload = {
      title: form.title,
      // prefer the live doc's markdown; the string form.description is the
      // fallback (defensive against editor remounts)
      description: (descriptionEditor.value?.getMarkdown() ?? '').trim() || form.description,
      assigneeId: form.assigneeId === NONE_ID ? null : form.assigneeId,
      projectId: form.projectId === NONE_ID ? null : form.projectId,
      reviewers: form.reviewers,
    };
    if (editingId.value) {
      await updateMutation.mutateAsync({ id: editingId.value, ...payload });
    } else {
      await createMutation.mutateAsync({
        ...payload,
        status: form.status,
        ...(props.parentTaskId ? { parentId: props.parentTaskId } : {}),
      });
    }
    open.value = false;
    emit('saved');
  } catch (e) {
    messageOk.value = false;
    message.value = errorMessage(e, "Couldn't save the task — try again");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="isEdit ? 'Edit task' : 'New task'"
    :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]', body: 'overflow-y-auto' }"
  >
    <template #body>
      <UForm id="task-editor-form" :state="form" class="space-y-4" @submit="save">
        <UFormField label="Title" name="title">
          <template #hint><FormHint text="Short summary of the work" /></template>
          <UInput v-model="form.title" icon="i-lucide-list-todo" placeholder="Task title" class="w-full" required />
        </UFormField>
        <UFormField label="Description" name="description">
          <template #hint
            ><FormHint
              text="What needs to be done; @mention employees — AI agents receive it as their instructions. Add a title first — files attach to a saved task"
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
            placeholder="Description (optional) — paste/drop images to attach; type @ to mention an employee"
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
        <UFormField v-show="!isEdit" label="Status" name="status">
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
            :items="employees.map((e) => ({ label: e.kind === 'ai' ? `${e.name} (AI)` : e.name, value: e.id }))"
            value-key="value"
            icon="i-lucide-user-check"
            placeholder="Add reviewers…"
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
      <div class="flex w-full justify-end gap-2">
        <UButton variant="ghost" color="neutral" label="Cancel" :disabled="busy" @click="open = false" />
        <UButton
          type="submit"
          :loading="busy"
          :label="isEdit ? 'Save changes' : 'Create task'"
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
