// Apple로 로그인 (REQ-F-772), on the sign-in page inside the iOS app. The server gives a nonce (its sha256, the raw
// one stays in a cookie), the app asks the system for an Apple ID with it and calls back with the identity token,
// which goes to the server as a form so its answer (the app, or the waiting page) is simply the next page.
;(() => {
  const button = document.getElementById('apple-login')
  const error = document.getElementById('apple-error')
  const native = window.webkit?.messageHandlers?.appleSignIn
  if (!button) return
  // An older app without the handler: the button would do nothing, so it is not shown.
  if (!native) return void (button.hidden = true)
  const say = (text) => {
    error.textContent = text
    error.hidden = !text
  }
  const busy = (on) => {
    button.disabled = on
  }
  button.addEventListener('click', async () => {
    say('')
    busy(true)
    try {
      const r = await fetch('/api/auth/apple/nonce', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      if (!r.ok) throw new Error(r.status === 429 ? '너무 자주 시도했어요. 1분 뒤에 다시 해 주세요.' : '로그인을 시작하지 못했어요. 다시 시도해 주세요.')
      native.postMessage({ nonce: (await r.json()).nonce })
    } catch (e) {
      say(e.message)
      busy(false)
    }
  })
  // The app calls these when the system sheet is done.
  window.appleSignInDone = ({ token, code, name }) => {
    const form = document.createElement('form')
    form.method = 'post'
    form.action = '/api/auth/apple'
    for (const [k, v] of Object.entries({ token, code: code ?? '', name: name ?? '' })) {
      const i = document.createElement('input')
      i.type = 'hidden'
      i.name = k
      i.value = v
      form.append(i)
    }
    document.body.append(form)
    form.submit()
  }
  window.appleSignInFailed = (message) => {
    busy(false)
    say(message || '')
  }
})()
