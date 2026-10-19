#!/usr/bin/env python3
"""App icon tuner: python3 ios/tools/icon.py [port]

Serves a page that moves the speech bubble up or down (left and right always centred), shows the four margins on
the 1024 canvas, and writes the chosen one to ios/icon.svg and the app icon PNG. Standard library only; the PNG is
drawn with macOS's qlmanage and sips.
"""
import json
import math
import os
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
IOS = os.path.dirname(HERE)
SVG_OUT = os.path.join(IOS, 'icon.svg')
PNG_OUT = os.path.join(IOS, 'Bridge', 'Assets.xcassets', 'AppIcon.appiconset', 'icon-1024.png')

# The bubble: 690 wide on the 1024 canvas, body √2 : 1, corner radius 2/5 of the body, tail 0.246 of the body,
# stroke 72 × 690/734. Inside, ">" of half-height a and "_" of length 2a, a apart.
W = 690.0
A = math.sqrt(2)
T = 72 * W / 734
BG = '#c96442'


def glyph():
    """The white lines, laid out with the bubble's box at x = 0..W, y = 0..H (stroke included). Returns (paths, H)."""
    h = W / A
    tail = 0.246 * h
    x0, x1, y0, y1 = T / 2, W - T / 2, T / 2, h - T / 2
    r = 0.4 * h - T / 2
    tx = x0 + r
    tb = h + tail - T / 2
    tr = tx + (tb - y1) * 1.156
    f = lambda v: f'{v:.2f}'
    body = (f'M{f(tx)} {f(y0)}H{f(x1 - r)}A{f(r)} {f(r)} 0 0 1 {f(x1)} {f(y0 + r)}V{f(y1 - r)}'
            f'A{f(r)} {f(r)} 0 0 1 {f(x1 - r)} {f(y1)}H{f(tr)}L{f(tx)} {f(tb)}V{f(y1)}'
            f'A{f(r)} {f(r)} 0 0 1 {f(x0)} {f(y1 - r)}V{f(y0 + r)}A{f(r)} {f(r)} 0 0 1 {f(tx)} {f(y0)}Z')
    a = 64 * (h / 520)
    cy = (y0 + y1) / 2
    start = W / 2 - (4 * a + 2 * T) / 2
    cx = start + T / 2
    ux = start + 2 * a + T + T / 2
    inner = f'M{f(cx)} {f(cy - a)}L{f(cx + a)} {f(cy)}L{f(cx)} {f(cy + a)}M{f(ux)} {f(cy + a)}H{f(ux + 2 * a)}'
    return [body, inner], h + tail


PATHS, H = glyph()


def svg(top):
    """The icon with the bubble's top edge at `top`, centred left to right."""
    left = (1024 - W) / 2
    lines = ''.join(f'<path d="{d}"/>' for d in PATHS)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="{BG}"/>'
            f'<g transform="translate({left:.2f} {top:.2f})" fill="none" stroke="#fff" stroke-width="{T:.2f}" '
            f'stroke-linecap="round" stroke-linejoin="round">{lines}</g></svg>\n')


def write(top):
    """ios/icon.svg and the app icon PNG (1024, no alpha, as App Store Connect wants)."""
    with open(SVG_OUT, 'w') as f:
        f.write(svg(top))
    with tempfile.TemporaryDirectory() as d:
        subprocess.run(['qlmanage', '-t', '-s', '1024', '-o', d, SVG_OUT], check=True, capture_output=True)
        png = os.path.join(d, 'icon.svg.png')
        jpg = os.path.join(d, 'icon.jpg')
        subprocess.run(['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '100', png, '--out', jpg], check=True, capture_output=True)
        subprocess.run(['sips', '-s', 'format', 'png', jpg, '--out', PNG_OUT], check=True, capture_output=True)


PAGE = r'''<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>아이콘 여백</title>
<style>
:root{color-scheme:dark;--bg:#18181a;--fg:#eee;--muted:#999;--line:#333;--accent:#c96442}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px -apple-system,system-ui,sans-serif;padding:16px;max-width:560px;margin-inline:auto}
h1{font-size:18px;margin:4px 0 14px}
.stage{display:flex;gap:16px;align-items:flex-end;justify-content:center;margin-bottom:16px}
.big{width:min(72vw,300px);aspect-ratio:1;border-radius:22.37%;overflow:hidden;position:relative}
.small{width:60px;aspect-ratio:1;border-radius:22.37%;overflow:hidden}
.big svg,.small svg{display:block;width:100%;height:100%}
.guide{position:absolute;inset:0;pointer-events:none}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0}
.cell{border:1px solid var(--line);border-radius:10px;padding:8px 10px}
.cell b{font-size:20px}
.cell span{color:var(--muted);font-size:13px;display:block}
input[type=range]{width:100%;accent-color:var(--accent)}
.row{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
button{flex:1;min-height:44px;border-radius:10px;border:1px solid var(--line);background:#26262a;color:var(--fg);font-size:15px}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
label{display:flex;justify-content:space-between;color:var(--muted);font-size:14px}
.note{color:var(--muted);font-size:13px;line-height:1.5}
#msg{min-height:22px;margin-top:8px}
</style></head><body>
<h1>앱 아이콘 위아래 여백</h1>
<div class="stage">
  <div class="big" id="big"></div>
  <div class="small" id="small"></div>
</div>
<label><span>위로</span><span>위 여백 <b id="topv"></b></span><span>아래로</span></label>
<input id="top" type="range" step="1">
<div class="grid">
  <div class="cell"><span>위</span><b id="u"></b> <span id="up"></span></div>
  <div class="cell"><span>아래</span><b id="d"></b> <span id="dp"></span></div>
  <div class="cell"><span>왼쪽</span><b id="l"></b> <span id="lp"></span></div>
  <div class="cell"><span>오른쪽</span><b id="r"></b> <span id="rp"></span></div>
</div>
<div class="row">
  <button id="center">위아래 같게</button>
  <button id="optical">눈 가운데(위로 3%)</button>
  <button id="guides">격자 보기</button>
</div>
<div class="row"><button class="primary" id="apply">앱 아이콘으로 적용</button></div>
<div id="msg" class="note"></div>
<p class="note">1024 칸 기준 px. 좌우는 항상 가운데. Apple 메시지 아이콘은 위아래 각 187, 좌우 각 145.</p>
<script>
const C = __CONFIG__;
const $ = (id) => document.getElementById(id);
const slider = $('top');
slider.min = 0; slider.max = Math.floor(1024 - C.h); slider.value = Math.round((1024 - C.h) / 2);
let guides = false;
const pct = (v) => (v / 1024 * 100).toFixed(1) + '%';
function svg(top, withGuides) {
  const left = (1024 - C.w) / 2;
  const paths = C.paths.map((d) => `<path d="${d}"/>`).join('');
  let g = '';
  if (withGuides) {
    const s = 'stroke="rgba(255,255,255,.45)" stroke-width="3" stroke-dasharray="10 10"';
    g = `<line x1="512" y1="0" x2="512" y2="1024" ${s}/><line x1="0" y1="512" x2="1024" y2="512" ${s}/>` +
        `<rect x="${left}" y="${top}" width="${C.w}" height="${C.h}" fill="none" stroke="rgba(255,230,120,.8)" stroke-width="4"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="${C.bg}"/>` +
    `<g transform="translate(${left} ${top})" fill="none" stroke="#fff" stroke-width="${C.t}" stroke-linecap="round" stroke-linejoin="round">${paths}</g>${g}</svg>`;
}
function draw() {
  const top = +slider.value, bottom = 1024 - C.h - top, side = (1024 - C.w) / 2;
  $('big').innerHTML = svg(top, guides);
  $('small').innerHTML = svg(top, false);
  $('topv').textContent = top;
  $('u').textContent = top; $('up').textContent = pct(top);
  $('d').textContent = Math.round(bottom); $('dp').textContent = pct(bottom);
  $('l').textContent = Math.round(side); $('lp').textContent = pct(side);
  $('r').textContent = Math.round(side); $('rp').textContent = pct(side);
}
slider.oninput = draw;
$('center').onclick = () => { slider.value = Math.round((1024 - C.h) / 2); draw(); };
$('optical').onclick = () => { slider.value = Math.round((1024 - C.h) / 2 - 1024 * 0.03); draw(); };
$('guides').onclick = () => { guides = !guides; draw(); };
$('apply').onclick = async () => {
  $('msg').textContent = '적용하는 중…';
  try {
    const r = await fetch('/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ top: +slider.value }) });
    const j = await r.json();
    $('msg').textContent = j.ok ? `적용했어요: 위 ${j.top} · 아래 ${j.bottom} · 좌우 ${j.side}` : '적용 못 했어요: ' + j.error;
  } catch (e) { $('msg').textContent = '적용 못 했어요: ' + e; }
};
draw();
</script>
</body></html>
'''


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, kind):
        data = body.encode()
        self.send_response(code)
        self.send_header('content-type', kind)
        self.send_header('content-length', str(len(data)))
        self.send_header('cache-control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path != '/':
            return self._send(404, 'not found', 'text/plain; charset=utf-8')
        config = {'paths': PATHS, 'w': W, 'h': H, 't': round(T, 2), 'bg': BG}
        self._send(200, PAGE.replace('__CONFIG__', json.dumps(config)), 'text/html; charset=utf-8')

    def do_POST(self):
        if self.path != '/apply':
            return self._send(404, 'not found', 'text/plain; charset=utf-8')
        try:
            n = int(self.headers.get('content-length', '0'))
            top = float(json.loads(self.rfile.read(min(n, 1024)) or b'{}')['top'])
            if not 0 <= top <= 1024 - H:
                raise ValueError('위 여백이 범위를 벗어났어요')
            write(top)
            body = {'ok': True, 'top': round(top), 'bottom': round(1024 - H - top), 'side': round((1024 - W) / 2)}
        except Exception as e:  # shown on the page as it is
            body = {'ok': False, 'error': str(e)}
        self._send(200, json.dumps(body, ensure_ascii=False), 'application/json; charset=utf-8')

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f'http://localhost:{port}  (bubble {W:.0f} × {H:.0f}, side margins {(1024 - W) / 2:.0f})')
    ThreadingHTTPServer(('0.0.0.0', port), Handler).serve_forever()
