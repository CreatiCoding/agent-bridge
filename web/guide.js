// A copy button on every command block of a guide page.
for (const pre of document.querySelectorAll('pre[data-copy]')) {
  const text = pre.textContent
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'copy'
  b.textContent = '복사'
  b.onclick = async () => {
    await navigator.clipboard.writeText(text)
    b.textContent = '복사됨'
    setTimeout(() => (b.textContent = '복사'), 1500)
  }
  pre.append(b)
}
