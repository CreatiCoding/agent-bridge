// REQ-F-873: what a machine and its containers expose, read without changing anything.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { parseOsRelease, ecosystemOf, parseApkInstalled, parseDpkgStatus, parseDpkgQuery, firstTarFile, sshdSettings, sshBanner, parseDockerPs, topHasSshd, collectExposure, fit, ExposureRunner, PKG_MAX, EXPOSURE_MAX_BYTES } from '../../agent/exposure.mjs'

test('AC-1642 os-release and the ecosystem name', () => {
  const u = parseOsRelease('PRETTY_NAME="Ubuntu 24.04.4 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nVERSION="24.04.4 LTS (Noble Numbat)"\nID=ubuntu\n')
  assert.deepEqual([u.id, u.versionId, u.pretty], ['ubuntu', '24.04', 'Ubuntu 24.04.4 LTS'])
  assert.equal(ecosystemOf(u), 'Ubuntu:24.04:LTS')
  assert.equal(ecosystemOf(parseOsRelease('ID=ubuntu\nVERSION_ID="24.10"\nVERSION="24.10 (Oracular Oriole)"\nPRETTY_NAME="Ubuntu 24.10"')), 'Ubuntu:24.10')
  assert.equal(ecosystemOf(parseOsRelease('ID=debian\nVERSION_ID="12"\nPRETTY_NAME="Debian GNU/Linux 12 (bookworm)"')), 'Debian:12')
  assert.equal(ecosystemOf(parseOsRelease('ID=alpine\nVERSION_ID=3.20.3\nPRETTY_NAME="Alpine Linux v3.20"')), 'Alpine:v3.20')
  assert.equal(ecosystemOf(parseOsRelease('ID=fedora\nVERSION_ID=40')), '')
  assert.equal(parseOsRelease('NAME=x'), null)
})

test('AC-1642 package lists: apk origin, dpkg source and its version, installed only', () => {
  const apk = parseApkInstalled('P:libcrypto3\nV:3.3.2-r0\no:openssl\n\nP:musl\nV:1.2.5-r0\n\nP:libssl3\nV:3.3.2-r0\no:openssl\n')
  assert.deepEqual(apk.list, [['musl', '1.2.5-r0'], ['openssl', '3.3.2-r0']])
  const dpkg = parseDpkgStatus(
    'Package: libc6\nStatus: install ok installed\nSource: glibc\nVersion: 2.36-9\n\n' +
      'Package: libssl3\nStatus: install ok installed\nSource: openssl (3.0.14-1~deb12u1)\nVersion: 3.0.14-1~deb12u1+b1\n\n' +
      'Package: gone\nStatus: deinstall ok config-files\nVersion: 1\n\n' +
      'Package: bash\nStatus: install ok installed\nVersion: 5.2.15-2+b7\n',
  )
  assert.deepEqual(dpkg.list, [['bash', '5.2.15-2+b7'], ['glibc', '2.36-9'], ['openssl', '3.0.14-1~deb12u1']])
  const q = parseDpkgQuery('ii \topenssh\t1:9.6p1-3ubuntu13.5\nii \topenssh\t1:9.6p1-3ubuntu13.5\nrc \told\t1\n')
  assert.deepEqual(q.list, [['openssh', '1:9.6p1-3ubuntu13.5']])
  const many = parseApkInstalled(Array.from({ length: PKG_MAX + 3 }, (_, i) => `P:p${i}\nV:1`).join('\n\n'))
  assert.equal(many.list.length, PKG_MAX)
  assert.equal(many.cut, true)
})

test('AC-1642 the first file of a docker cp tar stream', () => {
  const header = (name, size, type) => {
    const h = Buffer.alloc(512)
    h.write(name, 0)
    h.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
    h.write(type, 156)
    return h
  }
  const pad = (b) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)])
  const body = Buffer.from('ID=alpine\n')
  const pax = Buffer.from('30 path=etc/os-release\n')
  const tar = Buffer.concat([header('PaxHeader', pax.length, 'x'), pad(pax), header('os-release', body.length, '0'), pad(body), Buffer.alloc(1024)])
  assert.equal(firstTarFile(tar).toString(), 'ID=alpine\n')
  assert.equal(firstTarFile(Buffer.alloc(1024)), null)
  assert.equal(firstTarFile(Buffer.from('nope')), null)
})

test('AC-1643 sshd_config: first value wins, Include in place, Match skipped, defaults, unreadable', () => {
  const files = {
    '/etc/ssh/sshd_config': 'Include /etc/ssh/sshd_config.d/*.conf\n#PasswordAuthentication no\nPermitRootLogin yes\nPasswordAuthentication no\nMatch User bob\n  PasswordAuthentication yes\n',
    '/etc/ssh/sshd_config.d/50-cloud-init.conf': 'PasswordAuthentication yes\n',
    '/etc/ssh/sshd_config.d/60-x.conf': 'PermitRootLogin=no\n',
  }
  const readFile = (p) => {
    if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return files[p]
  }
  const readdir = () => ['60-x.conf', '50-cloud-init.conf', 'README']
  assert.deepEqual(sshdSettings({ readFile, readdir }), { passwordAuth: 'yes', permitRootLogin: 'no', readable: true })
  files['/etc/ssh/sshd_config'] = 'Match User bob\n  PasswordAuthentication no\n'
  assert.deepEqual(sshdSettings({ readFile, readdir: () => [] }), { passwordAuth: 'yes', permitRootLogin: 'prohibit-password', readable: true })
  files['/etc/ssh/sshd_config'] = 'PermitRootLogin without-password\nInclude sshd_config.d/*.conf\n'
  const locked = (p) => {
    if (p.includes('50-')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    return readFile(p)
  }
  assert.deepEqual(sshdSettings({ readFile: locked, readdir }), { passwordAuth: 'unknown', permitRootLogin: 'prohibit-password', readable: false })
  assert.deepEqual(sshdSettings({ readFile: () => { throw new Error('ENOENT') } }), { passwordAuth: 'unknown', permitRootLogin: 'unknown', readable: false })
})

test('AC-1643 the ssh banner, and a closed port', async () => {
  const srv = net.createServer((s) => s.write('SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.5\r\n'))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  assert.deepEqual(await sshBanner({ port, ms: 2000 }), { listening: true, banner: 'SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.5' })
  await new Promise((r) => srv.close(r))
  const closed = await sshBanner({ port, ms: 2000 })
  assert.equal(closed.listening, false)
  assert.equal(closed.banner, '')
})

test('AC-1644 docker ps, docker top', () => {
  const ps = parseDockerPs('{"ID":"abc","Names":"web","Image":"nginx:1","Ports":"0.0.0.0:80->80/tcp","Labels":"x"}\nnot json\n')
  assert.deepEqual(ps, [{ id: 'abc', name: 'web', image: 'nginx:1', ports: '0.0.0.0:80->80/tcp' }])
  assert.equal(topHasSshd('UID PID CMD\nroot 1 /usr/sbin/sshd -D\n'), true)
  assert.equal(topHasSshd('UID PID CMD\nroot 1 sshd: /usr/sbin/sshd -D [listener]\n'), true)
  assert.equal(topHasSshd('UID PID CMD\nroot 1 nginx: master\n'), false)
})

const tarOf = (text) => {
  const b = Buffer.from(text)
  const h = Buffer.alloc(512)
  h.write('f', 0)
  h.write(`${b.length.toString(8).padStart(11, '0')}\0`, 124)
  h.write('0', 156)
  return Buffer.concat([h, b, Buffer.alloc((512 - (b.length % 512)) % 512), Buffer.alloc(1024)])
}
const ALPINE = 'ID=alpine\nVERSION_ID=3.20.1\nPRETTY_NAME="Alpine Linux v3.20"\n'
const apk = (ver) => `P:openssh-server\nV:${ver}\no:openssh\n`

/** A Linux host whose docker runs c1 (a) and c2 (b), both alpine:3.20 of one image id; `files[id]` is what each holds. */
async function twoContainers(files) {
  const calls = []
  const run = async (file, args) => {
    calls.push([file, ...args].join(' '))
    const ok = (out) => ({ ok: true, out: Buffer.isBuffer(out) ? out : Buffer.from(out), err: '' })
    if (file === 'dpkg-query') return ok('ii \topenssh\t1:9.6p1-3ubuntu13.5\n')
    if (args[0] === 'ps') return ok('{"ID":"c1","Names":"a","Image":"alpine:3.20","Ports":""}\n{"ID":"c2","Names":"b","Image":"alpine:3.20","Ports":"22/tcp"}\n')
    if (args[0] === 'inspect') return ok('c1full\tsha256:img\nc2full\tsha256:img\n')
    if (args[0] === 'cp') {
      const [id, f] = args[2].split(':')
      const t = files[id]?.[f]
      if (t != null) return ok(tarOf(t))
    }
    if (args[0] === 'top') return ok(args[1] === 'c2' ? 'UID PID CMD\nroot 1 /usr/sbin/sshd -D\n' : 'UID PID CMD\nroot 1 sleep\n')
    return { ok: false, out: Buffer.alloc(0), err: 'no' }
  }
  const host = { '/etc/os-release': 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION="24.04.4 LTS (Noble Numbat)"\nPRETTY_NAME="Ubuntu 24.04.4 LTS"\n', '/etc/ssh/sshd_config': 'PasswordAuthentication no\n' }
  const r = await collectExposure({
    platform: 'linux',
    readFile: (p) => {
      if (!(p in host)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return host[p]
    },
    readdir: () => [],
    run,
    banner: async () => ({ listening: true, banner: 'SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.5' }),
    docker: '/usr/bin/docker',
    now: () => 42,
  })
  return { r, calls }
}

test('AC-1644 two containers of one image with different packages: each reports its own, no Env asked', async () => {
  const { r, calls } = await twoContainers({
    c1: { '/etc/os-release': ALPINE, '/lib/apk/db/installed': apk('9.9_p2-r0') },
    c2: { '/etc/os-release': ALPINE, '/lib/apk/db/installed': apk('9.7_p1-r0') },
  })
  assert.deepEqual(r.os, { id: 'ubuntu', versionId: '24.04', pretty: 'Ubuntu 24.04.4 LTS' })
  assert.deepEqual(r.ssh, { listening: true, banner: 'SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.5', passwordAuth: 'no', permitRootLogin: 'prohibit-password' })
  assert.deepEqual(r.packages, { ecosystem: 'Ubuntu:24.04:LTS', list: [['openssh', '1:9.6p1-3ubuntu13.5']] })
  assert.equal(r.at, 42)
  assert.equal(r.containers.length, 2)
  const os = { id: 'alpine', versionId: '3.20.1', pretty: 'Alpine Linux v3.20' }
  assert.deepEqual(r.containers[0], { name: 'a', image: 'alpine:3.20', ports: '', os, sshd: false, packages: { ecosystem: 'Alpine:v3.20', list: [['openssh', '9.9_p2-r0']] } })
  assert.deepEqual(r.containers[1], { name: 'b', image: 'alpine:3.20', ports: '22/tcp', os, sshd: true, packages: { ecosystem: 'Alpine:v3.20', list: [['openssh', '9.7_p1-r0']] } })
  for (const id of ['c1', 'c2']) {
    assert.equal(calls.filter((c) => c.includes(` cp -L ${id}:`)).length, 2, `${id}: its own two files read`)
  }
  assert.ok(!calls.some((c) => /Env|Config/.test(c)), 'never asks for the environment')
  assert.deepEqual(r.errors, [])
})

test('AC-1644 a container whose files cannot be read is not filled from another of its image', async () => {
  const { r } = await twoContainers({ c1: { '/etc/os-release': ALPINE, '/lib/apk/db/installed': apk('9.9_p2-r0') }, c2: {} })
  assert.deepEqual(r.containers[0].packages, { ecosystem: 'Alpine:v3.20', list: [['openssh', '9.9_p2-r0']] })
  assert.equal(r.containers[1].os, null)
  assert.deepEqual(r.containers[1].packages, { ecosystem: '', list: [] })
  const first = await twoContainers({ c1: { '/etc/os-release': ALPINE }, c2: { '/etc/os-release': ALPINE, '/lib/apk/db/installed': apk('9.7_p1-r0') } })
  assert.deepEqual(first.r.containers[0].packages, { ecosystem: '', list: [] }, 'the first one failing is not cached for the second')
  assert.deepEqual(first.r.containers[1].packages, { ecosystem: 'Alpine:v3.20', list: [['openssh', '9.7_p1-r0']] })
})

test('AC-1645 over 2MB: package lists emptied first, noted', () => {
  const big = Array.from({ length: 5000 }, (_, i) => [`package-name-${i}`, `1.2.3-${'x'.repeat(200)}`])
  const out = { at: 1, os: null, ssh: {}, packages: { ecosystem: 'Debian:12', list: big.slice(0, 100) }, containers: [{ name: 'a', packages: { ecosystem: '', list: big } }, { name: 'b', packages: { ecosystem: '', list: big } }], errors: [] }
  fit(out)
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= EXPOSURE_MAX_BYTES)
  assert.equal(out.packages.list.length, 100, 'the smallest list stays')
  assert.ok(out.errors.some((e) => e.startsWith('size:')))
})

test('AC-1645 one run at a time', async () => {
  let n = 0
  let release
  const runner = new ExposureRunner(() => new Promise((r) => ((n += 1), (release = () => r({ n })))))
  const a = runner.run()
  const b = runner.run()
  assert.equal(a, b)
  await new Promise((r) => setImmediate(r))
  release()
  assert.deepEqual(await a, { n: 1 })
  assert.equal(runner.sent, false)
  const c = runner.run()
  assert.notEqual(c, a, 'after it ends, a new run')
  await new Promise((r) => setImmediate(r))
  release()
  assert.deepEqual(await c, { n: 2 })
})
