// The sign-in page, opened by an address of before (/#/s/<id>, /#/settings): the hash never reaches the server, so
// it is turned into its path here, and the server sends the person through sign-in and back to it.
// The paths are the control page's (server/server.mjs APP_PATH).
;(() => {
  const url = location.hash.slice(1)
  const path = url.split('?')[0]
  if (/^\/(?:s\/[\w-]+|new|stats|quality|hosts(?:\/[\w-]+)?|admin|settings(?:\/[a-z]+)?|guide(?:\/move)?)$/.test(path)) location.replace(url)
})()
