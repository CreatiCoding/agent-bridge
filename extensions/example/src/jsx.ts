// JSX without a bundler: the built files call h() and Fragment, which are the page's React (set by setReact).
// The import of 'react' is for types only and is dropped from what is built.
import * as ReactNS from 'react'

let R: typeof ReactNS
export let Fragment: typeof ReactNS.Fragment
export function setReact(r: typeof ReactNS) {
  R = r
  Fragment = r.Fragment
}
export function h(...a: Parameters<typeof ReactNS.createElement>) {
  return R.createElement(...a)
}
// Where TypeScript looks for the JSX types of h.
export declare namespace h {
  export import JSX = ReactNS.JSX
}
