import '@testing-library/jest-dom/vitest'

// jsdom implements neither: Radix's `Select` calls both when it opens (scrolling the
// highlighted option into view, and claiming pointer capture for drag-to-select), and without
// a stub either throws and fails a test that never meant to exercise them.
if (typeof Element !== 'undefined') {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {}
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {}
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {}
  }
}
