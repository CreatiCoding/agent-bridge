// The server writes what changed in memory to disk every META_FLUSH_MS (5 s by default). Tests that read those files
// start the server with a short one and wait a few of them instead of 5 s (1.496).
export const FLUSH = 200
export const FLUSH_ENV = { BRIDGE_META_FLUSH_MS: String(FLUSH) }
/** Long enough for at least one flush after whatever was just sent. */
export const flushed = () => new Promise((r) => setTimeout(r, FLUSH * 3))
