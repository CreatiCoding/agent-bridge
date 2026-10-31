let R;
export let Fragment;
export function setReact(r) {
    R = r;
    Fragment = r.Fragment;
}
export function h(...a) {
    return R.createElement(...a);
}
