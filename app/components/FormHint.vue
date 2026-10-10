<script setup lang="ts">
// Info icon with hover popover — drop-in for UFormField's #hint slot so field
// descriptions render consistently across every form.
const props = withDefaults(defineProps<{
  /** popover text */
  text: string
  /** accessible label defaults to text */
  label?: string
}>(), {})
</script>

<template>
  <UPopover :open-delay="0" :close-delay="100" mode="hover" :content="{ side: 'bottom', align: 'end' }">
    <UIcon
      name="i-lucide-info"
      class="size-4 shrink-0 cursor-help text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
      :aria-label="label ?? text"
      role="button"
      tabindex="0"
    />
    <template #content>
      <p class="max-w-60 px-3 py-2 text-xs leading-relaxed text-zinc-700 dark:text-zinc-200">{{ text }}</p>
    </template>
  </UPopover>
</template>
