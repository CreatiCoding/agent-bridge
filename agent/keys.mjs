// Who may sign an agent update (R1-I1, REQ-S-067): ed25519 public keys (SPKI DER, base64). The private keys stay on
// the signer's Mac (`~/.claude-bridge-signing/`), never in the repository or on the server. This file is one of the
// agent's files, so it is under the signature itself: a server that is broken into cannot swap these keys, and a new
// key reaches installed Macs only in an update signed by a key already here. A fork makes its own with
// `node scripts/sign-agent.mjs --init`; Macs installed from that fork's server then trust the fork's key.
// The second key is a reserve, already trusted, for replacing the first one without leaving agents behind.
export const UPDATE_KEYS = ['MCowBQYDK2VwAyEAIWqmaO3dhMWu2KXRTw0E+NwL4qs2yNYb/c+L3HXB8Q0=', 'MCowBQYDK2VwAyEApN1Lh4rPjKQpeQFhBkW2I3mhBnEsotQajvofD9T3hLE=']
