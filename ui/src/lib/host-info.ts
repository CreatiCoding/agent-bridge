// What a host slot's context says about a host (REQ-F-865): who it is and whether it is there, nothing more (no
// keys, no paths, no logs). Its runners say what it can run.
export interface HostInfo {
  id: string
  name: string
  kind: string
  online: boolean
  runners: string[]
}
export const hostInfo = (h: { id: string; name: string; kind?: string; online?: boolean; runners?: { id: string }[] | null }): HostInfo => ({
  id: h.id,
  name: h.name,
  kind: h.kind ?? '',
  online: !!h.online,
  runners: (h.runners ?? []).map((r) => r.id),
})
