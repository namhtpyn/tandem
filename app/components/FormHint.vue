<script setup lang="ts">
// Info icon with hover popover — drop-in for UFormField's #hint slot so field
// descriptions render consistently across every form.
withDefaults(
  defineProps<{
    /** popover text */
    text: string;
    /** accessible label defaults to text */
    label?: string;
  }>(),
  {},
);

// hover alone is keyboard-dead — focus/blur drive the same open state
const open = ref(false);
</script>

<template>
  <UPopover
    v-model:open="open"
    :open-delay="0"
    :close-delay="100"
    mode="hover"
    :content="{ side: 'bottom', align: 'end' }"
  >
    <UIcon
      name="i-lucide-info"
      class="text-dimmed hover:text-muted size-4 shrink-0 cursor-help"
      :aria-label="label ?? text"
      role="button"
      tabindex="0"
      @focus="open = true"
      @blur="open = false"
    />
    <template #content>
      <p class="text-muted max-w-60 px-3 py-2 text-xs leading-relaxed">{{ text }}</p>
    </template>
  </UPopover>
</template>
