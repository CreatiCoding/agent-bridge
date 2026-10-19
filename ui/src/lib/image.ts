// A picture made small enough to send: the longest side 1568px (what Claude reads at full detail), JPEG,
// unless it is already small. GIFs are sent as they are (they may move).
export async function shrinkImage(file: File): Promise<{ data: string; name: string }> {
  const raw = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
  if (file.type === 'image/gif' && file.size < 2_000_000) return { data: raw, name: file.name }
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image()
    i.onload = () => resolve(i)
    i.onerror = () => reject(new Error('그림을 읽지 못했어요'))
    i.src = raw
  })
  const MAX = 1568
  const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight))
  if (scale === 1 && file.size < 900_000 && /^image\/(png|jpeg|webp)$/.test(file.type)) return { data: raw, name: file.name }
  const c = document.createElement('canvas')
  c.width = Math.round(img.naturalWidth * scale)
  c.height = Math.round(img.naturalHeight * scale)
  const g = c.getContext('2d')
  if (!g) return { data: raw, name: file.name }
  g.fillStyle = '#fff'
  g.fillRect(0, 0, c.width, c.height)
  g.drawImage(img, 0, 0, c.width, c.height)
  return { data: c.toDataURL('image/jpeg', 0.85), name: file.name.replace(/\.\w+$/, '.jpg') }
}
