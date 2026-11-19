// 페이지 확대·축소 (REQ-F-921): the steps the link sheet's − / + go through, for a snapshot drawn as the page looked
// (scaled from fitting the sheet's width) and for reading mode (the text's size).

export const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const

/** The next step up from z (z itself when it is the largest). */
export function zoomIn(z: number): number {
  return ZOOMS.find((s) => s > z + 1e-6) ?? ZOOMS[ZOOMS.length - 1]
}

/** The next step down from z (z itself when it is the smallest). */
export function zoomOut(z: number): number {
  return [...ZOOMS].reverse().find((s) => s < z - 1e-6) ?? ZOOMS[0]
}

/** "125%". */
export function zoomLabel(z: number): string {
  return `${Math.round(z * 100)}%`
}
