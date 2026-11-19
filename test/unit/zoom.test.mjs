import test from 'node:test'
import assert from 'node:assert/strict'
import { ZOOMS, zoomIn, zoomLabel, zoomOut } from '../../ui/src/lib/zoom.ts'

test('AC-1832 링크 시트 확대·축소: 단계를 오르내리고 끝에서 멈춘다', () => {
  assert.equal(zoomIn(1), 1.1)
  assert.equal(zoomOut(1), 0.9)
  assert.equal(zoomIn(3), 3)
  assert.equal(zoomOut(0.5), 0.5)
  assert.equal(zoomIn(1.3), 1.5)
  assert.equal(zoomOut(1.3), 1.25)
  assert.equal(zoomLabel(0.67), '67%')
  assert.equal(zoomLabel(1.25), '125%')
  assert.ok(ZOOMS.includes(1))
})
