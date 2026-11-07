// REQ-F-880: a vertical swipe on the input box goes through the sent-message record like ↑/↓ (REQ-F-082), and a
// downward swipe that does not puts the keyboard away.
import test from 'node:test'
import assert from 'node:assert/strict'
import { swipeBegin, swipeMove } from '../../ui/src/lib/composer-swipe.ts'

const flat = { scrollTop: 0, clientHeight: 40, scrollHeight: 40 }

// A record of "a", "b", "c" behind ↑/↓ the way the composer keeps it (recall index or null).
function box(record = ['a', 'b', 'c'], typed = '') {
  const st = { text: typed, recall: null, blurred: 0 }
  const act = {
    picking: false,
    back: () => {
      if (st.text && st.recall == null) return false
      if (!record.length) return false
      st.recall = st.recall == null ? record.length - 1 : Math.max(0, st.recall - 1)
      st.text = record[st.recall]
      return true
    },
    forward: () => {
      if (st.recall == null) return false
      st.recall += 1
      if (st.recall >= record.length) (st.recall = null), (st.text = '')
      else st.text = record[st.recall]
      return true
    },
    blur: () => (st.blurred += 1),
  }
  return { st, act }
}

function drag(act, ys, start = swipeBegin(100, 500, flat, true)) {
  let s = start
  for (const y of ys) {
    if (!s) break
    s = swipeMove(s, 100, y, act)
  }
  return s
}

test('an upward swipe on an empty box brings back the last message, and every 40 px one more', () => {
  const { st, act } = box()
  drag(act, [470, 459])
  assert.equal(st.text, 'c')
  const b = box()
  drag(b.act, [459, 418, 377, 300])
  assert.equal(b.st.text, 'a')
  assert.equal(b.st.blurred, 0)
})

test('40 px or less, or a sideways swipe, does nothing', () => {
  const { st, act } = box()
  assert.ok(drag(act, [460]))
  assert.equal(st.text, '')
  let s = swipeBegin(100, 500, flat, true)
  s = swipeMove(s, 200, 440, act)
  assert.equal(st.text, '')
})

test('a downward swipe while going through the record goes forward, then empties, and never puts the keyboard away', () => {
  const { st, act } = box()
  drag(act, [459, 418, 459, 500, 541, 640])
  assert.equal(st.text, '')
  assert.equal(st.recall, null)
  assert.equal(st.blurred, 0)
})

test('a downward swipe that is not going through the record puts the keyboard away', () => {
  const { st, act } = box()
  assert.equal(drag(act, [541]), null)
  assert.equal(st.blurred, 1)
  assert.equal(st.text, '')
})

test('typed text, an empty record and the open slash list are left alone', () => {
  const typed = box(['a'], 'hello')
  assert.equal(drag(typed.act, [459]), null)
  assert.equal(typed.st.text, 'hello')
  const none = box([])
  assert.equal(drag(none.act, [459]), null)
  const slash = box()
  slash.act.picking = true
  assert.equal(drag(slash.act, [459]), null)
  assert.equal(slash.st.text, '')
})

test('text that can still scroll scrolls first', () => {
  const tall = { scrollTop: 20, clientHeight: 40, scrollHeight: 200 }
  const { st, act } = box()
  assert.equal(drag(act, [459], swipeBegin(100, 500, tall, true)), null)
  assert.equal(drag(act, [541], swipeBegin(100, 500, tall, true)), null)
  assert.equal(st.text, '')
  assert.equal(st.blurred, 0)
  // Starting on the chips or the buttons (not the text) follows the swipe even then.
  drag(act, [459], swipeBegin(100, 500, tall, false))
  assert.equal(st.text, 'c')
})
