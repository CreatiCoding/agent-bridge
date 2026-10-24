<script setup lang="ts">
import { onMounted, ref } from 'vue'

// Shows only the changelog lines of one scope. The lines are plain Markdown list items; each carries its
// scope in a .rel-scope span ("화면", "서버·에이전트"), written by scripts/prepare.mjs.
const scopes = ['전체', '화면', '서버', '에이전트']
const current = ref('전체')

function apply(scope: string) {
  current.value = scope
  for (const li of document.querySelectorAll<HTMLElement>('.vp-doc li')) {
    const tag = li.querySelector('.rel-scope')
    if (!tag) continue
    li.style.display = scope === '전체' || tag.textContent?.split('·').includes(scope) ? '' : 'none'
  }
}

onMounted(() => apply(current.value))
</script>

<template>
  <div class="cl-filter" role="group" aria-label="범위로 거르기">
    <button
      v-for="s in scopes"
      :key="s"
      type="button"
      :class="{ on: s === current }"
      :aria-pressed="s === current"
      @click="apply(s)"
    >
      {{ s }}
    </button>
  </div>
</template>

<style scoped>
.cl-filter { display: flex; flex-wrap: wrap; gap: 8px; margin: 20px 0 8px; }
.cl-filter button {
  padding: 5px 12px; border-radius: 999px; border: 1px solid var(--vp-c-divider);
  font: 500 13px/1.4 var(--vp-font-family-mono); color: var(--vp-c-text-2); background: var(--vp-c-bg-soft);
}
.cl-filter button.on { color: var(--vp-c-brand-1); border-color: var(--vp-c-brand-1); background: var(--vp-c-brand-soft); }
</style>
