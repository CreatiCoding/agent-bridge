// What of the answer being written (REQ-F-137) is shown. The preview is read off the terminal, so it can still hold
// what the finished answer turns into something else, and it can outlive its turn when the stream dropped.
import type { Phase } from './types'

/**
 * A ```choices block (REQ-F-136), closed or still being written at the end. The preview rebuilds it from the screen
 * as a code block with the language line `choices`; the finished answer shows it as buttons instead.
 */
const CHOICES_BLOCK_RE = /\n?```choices[ \t]*\n[\s\S]*?(?:\n```[ \t]*(?=\n|$)|$)/g

/** The preview text to draw: '' when nothing is being written now, or when only a choices block is left. */
export function writingShown(text: string, phase: Phase | null | undefined): string {
  // No turn is running: whatever is left is a preview whose clearing was missed (a dropped stream), not news.
  if (phase === 'idle' || phase === 'ended') return ''
  const shown = text.replace(CHOICES_BLOCK_RE, '').replace(/\s+$/, '')
  return shown.trim() ? shown : ''
}
