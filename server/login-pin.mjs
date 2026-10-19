// A GitHub login name is not an identity: it can be renamed, and the old name taken by someone else. Access and the
// operator role are given by name (GITHUB_ALLOWED_LOGINS, BRIDGE_ADMIN_LOGINS, the access page), so the first GitHub
// account seen with a name keeps it (R1-L1). The record is its own (login-pins.json), not users.json: a person who
// renames signs in under the new name and their users entry changes, but the old name stays theirs.
// Only an operator lets a name go (the access page, R3-L2).

/**
 * The pins as saved (login-pins.json), or, when there is no such file yet, made once from the GitHub accounts
 * already known. Made only then: a name an operator let go must not be pinned again at the next start (R4-M2).
 * Keys are login names, so the map has no prototype: `constructor` is a name like any other (R4-L1).
 */
export function loadPins(saved, users) {
  const pins = Object.create(null)
  if (saved && typeof saved === 'object') {
    for (const [l, uid] of Object.entries(saved)) if (typeof uid === 'string') pins[l] = uid
    return pins
  }
  // A name an operator let go is `<name>#released` in users.json (1.164): never pinned again from there.
  for (const [id, u] of Object.entries(users ?? {})) {
    const l = String(u?.login ?? '').toLowerCase()
    if (id.startsWith('gh') && l && !l.endsWith('#released') && !Object.hasOwn(pins, l)) pins[l] = id
  }
  return pins
}

/** The other account holding the name, without pinning anything. */
export function heldBy(pins, uid, login) {
  const l = String(login).toLowerCase()
  return Object.hasOwn(pins, l) && pins[l] !== uid ? pins[l] : null
}

/**
 * A GitHub account signing in with a login name. Returns the other account that holds the name (and changes
 * nothing), or null after pinning the name to this account if it was free.
 */
export function claimLogin(pins, uid, login) {
  const other = heldBy(pins, uid, login)
  if (other) return other
  pins[String(login).toLowerCase()] = uid
  return null
}
