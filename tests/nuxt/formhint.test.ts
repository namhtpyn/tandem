// Component test (Nuxt environment): FormHint — the icon carries an aria-label from the
// text prop (popover content only renders on hover, which happy-dom can't trigger).
import { expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import FormHint from '~/components/FormHint.vue'

it('FormHint exposes the hint text as the icon aria-label', async () => {
  const c = await mountSuspended(FormHint, { props: { text: 'Short summary of the work' } })
  expect(c.find('[aria-label="Short summary of the work"]').exists()).toBe(true)
})

it('FormHint prefers an explicit label when given', async () => {
  const c = await mountSuspended(FormHint, { props: { text: 'hint body', label: 'Hint about this field' } })
  expect(c.find('[aria-label="Hint about this field"]').exists()).toBe(true)
})
