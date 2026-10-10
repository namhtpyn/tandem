<script setup lang="ts">
// M1 overview: placeholder cards until environments/employees/tasks land (M2-M4).
</script>

<template>
  <div class="space-y-6 p-6 lg:p-8">
    <div>
      <h2 class="text-lg font-semibold text-zinc-900 dark:text-white">Overview</h2>
      <p class="text-sm text-zinc-500">Company workspace — humans and AI employees, one hierarchy.</p>
    </div>

    <div class="grid gap-4 sm:grid-cols-3">
      <UCard>
        <div class="flex items-center gap-3">
          <div class="flex size-9 items-center justify-center rounded-lg bg-primary/10">
            <UIcon name="i-lucide-server" class="size-5 text-primary" />
          </div>
          <div>
            <p class="text-sm font-medium text-zinc-900 dark:text-white">Environments</p>
            <p class="text-xs text-zinc-400">SSH targets that run Hermes</p>
          </div>
        </div>
      </UCard>
      <UCard>
        <div class="flex items-center gap-3">
          <div class="flex size-9 items-center justify-center rounded-lg bg-primary/10">
            <UIcon name="i-lucide-users" class="size-5 text-primary" />
          </div>
          <div>
            <p class="text-sm font-medium text-zinc-900 dark:text-white">Employees</p>
            <p class="text-xs text-zinc-400">Humans + AI, titles & hierarchy — M3</p>
          </div>
        </div>
      </UCard>
      <UCard>
        <div class="flex items-center gap-3">
          <div class="flex size-9 items-center justify-center rounded-lg bg-primary/10">
            <UIcon name="i-lucide-list-todo" class="size-5 text-primary" />
          </div>
          <div>
            <p class="text-sm font-medium text-zinc-900 dark:text-white">Tasks</p>
            <p class="text-xs text-zinc-400">Assign & track work — M4</p>
          </div>
        </div>
      </UCard>
    </div>
  </div>
</template>
