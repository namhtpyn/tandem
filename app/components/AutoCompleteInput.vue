<script setup lang="ts">
import { nonNull } from '#shared/utils/non-null';
// Autocomplete input: free text always commits to v-model; matching suggestions
// appear in a dropdown while typing. Unlike UInputMenu, typed text that matches
// nothing is a first-class value (caller decides to create it as a record).
const props = withDefaults(
  defineProps<{
    modelValue: string;
    items: string[];
    placeholder?: string;
    icon?: string;
    disabled?: boolean;
    createHint?: string;
  }>(),
  {
    placeholder: '',
    icon: undefined,
    disabled: false,
    createHint: undefined,
  },
);

const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();

const open = ref(false);
const activeIndex = ref(0);
const root = ref<HTMLElement | null>(null);

// combobox ARIA: the UInput lands attrs on the real <input>; options carry ids
// so aria-activedescendant can point at the active one
const listboxId = useId();
const activeDescendant = computed(() =>
  open.value && matches.value.length ? `${listboxId}-option-${activeIndex.value}` : undefined,
);

const text = computed(() => props.modelValue);
const matches = computed(() => {
  const q = text.value.trim().toLowerCase();
  if (!q) return props.items.slice(0, 8);
  return props.items.filter((i) => i.toLowerCase().includes(q)).slice(0, 8);
});
const exactMatch = computed(() => props.items.some((i) => i.toLowerCase() === text.value.trim().toLowerCase()));

function input(v: string) {
  emit('update:modelValue', v);
  activeIndex.value = 0;
  open.value = true;
}
function pick(v: string) {
  emit('update:modelValue', v);
  open.value = false;
}
function onKeydown(e: KeyboardEvent) {
  if (!open.value || matches.value.length === 0) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeIndex.value = (activeIndex.value + 1) % matches.value.length;
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeIndex.value = (activeIndex.value - 1 + matches.value.length) % matches.value.length;
  } else if (e.key === 'Enter') {
    e.preventDefault();
    pick(nonNull(matches.value[activeIndex.value]));
  } else if (e.key === 'Escape') {
    open.value = false;
  }
}
function onDocClick(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) open.value = false;
}
onMounted(() => document.addEventListener('mousedown', onDocClick));
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocClick));
</script>

<template>
  <div ref="root" class="relative w-full">
    <UInput
      :model-value="text"
      :placeholder="placeholder"
      :icon="icon"
      :disabled="disabled"
      class="w-full"
      autocomplete="off"
      role="combobox"
      aria-autocomplete="list"
      :aria-expanded="open"
      :aria-controls="open ? listboxId : undefined"
      :aria-activedescendant="activeDescendant"
      @update:model-value="input"
      @focus="open = true"
      @blur="open = false"
      @keydown="onKeydown"
    />
    <div
      :id="listboxId"
      v-if="open && (matches.length > 0 || (createHint && text.trim() && !exactMatch))"
      class="border-default bg-default absolute top-full right-0 left-0 z-20 mt-1 max-h-56 overflow-auto rounded-md border shadow-lg"
      role="listbox"
    >
      <button
        v-for="(m, i) in matches"
        :id="`${listboxId}-option-${i}`"
        :key="m"
        type="button"
        role="option"
        :aria-selected="i === activeIndex"
        class="hover:bg-elevated/60 flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
        :class="i === activeIndex ? 'bg-elevated/60' : ''"
        @mousedown.prevent="pick(m)"
        @mousemove="activeIndex = i"
      >
        <span class="truncate">{{ m }}</span>
      </button>
      <div
        v-if="createHint && text.trim() && !exactMatch"
        class="border-default text-dimmed border-t px-3 py-1.5 text-xs"
      >
        {{ createHint }}
      </div>
    </div>
  </div>
</template>
