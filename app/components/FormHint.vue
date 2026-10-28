<script setup lang="ts">
// Info icon popover — drop-in for UFormField's #hint slot so field descriptions
// render consistently across every form.
withDefaults(
  defineProps<{
    /** popover text */
    text: string;
    /** accessible label defaults to text */
    label?: string;
  }>(),
  {},
);

// Controlled open state covering every input mode: reka's hover mode drives
// pointer enter/leave (including the bridge onto the content — hover alone is
// keyboard-dead), @focus/@blur cover keyboard focus, @click opens for touch,
// and Enter/Space toggle so keyboard users can dismiss what focus opened.
const open = ref(false);
let closeTimer: ReturnType<typeof setTimeout> | undefined;

function openNow() {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = undefined;
  }
  open.value = true;
}

function closeSoon() {
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    open.value = false;
    closeTimer = undefined;
  }, 120);
}

function toggle() {
  if (open.value) {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = undefined;
    }
    open.value = false;
  } else {
    openNow();
  }
}

onBeforeUnmount(() => {
  if (closeTimer) clearTimeout(closeTimer);
});
</script>

<template>
  <UPopover
    v-model:open="open"
    mode="hover"
    enable-touch
    :open-delay="0"
    :close-delay="100"
    :content="{ side: 'bottom', align: 'end' }"
  >
    <UIcon
      name="i-lucide-info"
      class="text-dimmed hover:text-muted focus-visible:ring-primary -m-2 size-3.5 shrink-0 cursor-help self-center rounded-full p-2 focus-visible:ring-2 focus-visible:outline-none"
      :aria-label="label ?? text"
      role="button"
      tabindex="0"
      @click="openNow"
      @focus="openNow"
      @blur="closeSoon"
      @keydown.enter.prevent="toggle"
      @keydown.space.prevent="toggle"
    />
    <template #content>
      <p class="text-muted max-w-60 px-3 py-2 text-xs leading-relaxed">{{ text }}</p>
    </template>
  </UPopover>
</template>
