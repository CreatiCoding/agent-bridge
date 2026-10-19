// The container starts the server as root (the data volume may hold files root made). Once the state is this
// server's (after the hand-over, when the old server writes nothing more), the data folder is given to the `node`
// user and the server goes on as that user (R1-L5). If any file cannot be given over, it stays root rather than
// run into files it cannot write.
import fs from 'node:fs'
import path from 'node:path'

/** The `node` user of the official node images. */
export const NODE_UID = 1000
export const NODE_GID = 1000

/** Every path under dir (dir too) not owned by uid:gid is given to it. Returns how many could not be. */
export function chownTree(dir, uid, gid, chown = fs.lchownSync) {
  let failed = 0
  const walk = (p) => {
    let st
    try {
      st = fs.lstatSync(p)
    } catch {
      return
    }
    if (st.uid !== uid || st.gid !== gid) {
      try {
        chown(p, uid, gid)
      } catch {
        failed++
      }
    }
    if (st.isDirectory()) for (const name of fs.readdirSync(p)) walk(path.join(p, name))
  }
  walk(dir)
  return failed
}

/**
 * When running as root: hand dir to NODE_UID and become that user. `BRIDGE_RUN_AS_ROOT=1` keeps root.
 * Returns what happened, for the log.
 */
export function dropRoot(dir, { env = process.env, proc = process } = {}) {
  if (typeof proc.getuid !== 'function' || proc.getuid() !== 0) return 'root 아님'
  if (env.BRIDGE_RUN_AS_ROOT === '1') return 'BRIDGE_RUN_AS_ROOT=1 이라 root 로 둠'
  const failed = chownTree(dir, NODE_UID, NODE_GID)
  if (failed) return `${failed}개를 node 에게 넘기지 못해 root 로 둠`
  try {
    proc.setgroups?.([NODE_GID])
    proc.setgid(NODE_GID)
    proc.setuid(NODE_UID)
  } catch (e) {
    return `node 사용자로 바꾸지 못해 root 로 둠 (${e.message})`
  }
  return `node(${NODE_UID}) 사용자로 바꿈`
}

/**
 * Every file under dir readable by its owner only (0600), every folder 0700 (R1-L6): a file's mode is set when it is
 * made, so the conversations and logs written before 1.159 kept 0644. Links are left alone. Returns how many changed.
 */
export function tightenTree(dir) {
  let changed = 0
  const walk = (p) => {
    let st
    try {
      st = fs.lstatSync(p)
    } catch {
      return
    }
    if (st.isSymbolicLink()) return
    const want = st.isDirectory() ? 0o700 : 0o600
    if ((st.mode & 0o777) !== want) {
      try {
        fs.chmodSync(p, want)
        changed++
      } catch {}
    }
    // A folder that cannot be read is left as it is: the server starts all the same (R6-L2).
    let names = []
    try {
      if (st.isDirectory()) names = fs.readdirSync(p)
    } catch {}
    for (const name of names) walk(path.join(p, name))
  }
  walk(dir)
  return changed
}
