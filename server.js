'use strict';
// MEOPANEL — بدون وابستگی خارجی؛ فقط Node.js 20+
const http = require('http'), net = require('net'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const PORT = +process.env.PORT || 3000;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });
const DBF = path.join(DATA, 'db.json');
const rid = (n = 6) => crypto.randomBytes(n).toString('hex');
const pbk = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');

/* ---------- دیتابیس (فایل JSON) ---------- */
let db;
function save() { fs.writeFileSync(DBF + '.tmp', JSON.stringify(db)); fs.renameSync(DBF + '.tmp', DBF); }
function init() {
  const user = process.env.ADMIN_USER || 'admin';
  const pass = process.env.ADMIN_PASS || 'admin';
  const salt = rid(8);
  db = { secret: rid(24), admin: { user, salt, hash: pbk(pass, salt), mustChange: pass === 'admin' }, settings: { publicHost: '', connectAddress: '' }, inbounds: [], users: [] };
  const mk = (name, core, protocol, port) => ({ id: rid(4), name, core, protocol, port, path: '/' + rid(5), enabled: true, bytes: 0 });
  // اینباندهای خودکار
  db.inbounds.push(mk('Xray VLESS', 'xray', 'vless', 20001), mk('Xray Trojan', 'xray', 'trojan', 20002),
    mk('SingBox VLESS', 'singbox', 'vless', 20003), mk('SingBox VMess', 'singbox', 'vmess', 20004));
  db.users.push(newUser({ name: 'test', limitGB: 5, days: 30 }));
  save();
  if (db.admin.mustChange) console.log('\n[MEOPANEL] اولین ورود: نام کاربری admin و رمز admin (بعد از ورود باید رمز را عوض کنید)\n');
}
function newUser(d) {
  return { id: rid(4), name: String(d.name || 'user').slice(0, 40), uuid: crypto.randomUUID(), enabled: true,
    limitGB: +d.limitGB || 0, expireAt: d.days ? Date.now() + d.days * 864e5 : 0, used: 0, note: d.note || '', subToken: rid(10), createdAt: Date.now() };
}
try { db = JSON.parse(fs.readFileSync(DBF, 'utf8')); } catch { init(); }
db.outbounds = db.outbounds || [];

/* ---------- هسته‌ها ---------- */
const active = () => db.users.filter(u => u.enabled && (!u.expireAt || u.expireAt > Date.now()) && (!u.limitGB || u.used < u.limitGB * 1e9));
const dummy = () => ({ id: 'none', uuid: crypto.randomUUID() });
const usedOut = i => db.outbounds.find(o => o.enabled && o.id === i.outbound);
function buildXray() {
  const us = active(); if (!us.length) us.push(dummy());
  const inbounds = [{ tag: 'api', listen: '127.0.0.1', port: 10085, protocol: 'dokodemo-door', settings: { address: '127.0.0.1' } }];
  for (const i of db.inbounds.filter(x => x.enabled && x.core === 'xray')) {
    const clients = us.map(u => i.protocol === 'trojan' ? { password: u.uuid, email: u.id + '@meo' } : { id: u.uuid, email: u.id + '@meo' });
    inbounds.push({ tag: 'in-' + i.id, listen: '127.0.0.1', port: i.port, protocol: i.protocol,
      settings: i.protocol === 'vless' ? { clients, decryption: 'none' } : { clients },
      streamSettings: { network: 'ws', wsSettings: { path: i.path } } });
  }
  const outs = [{ protocol: 'freedom', tag: 'direct' }, { protocol: 'blackhole', tag: 'block' }];
  const rules = [{ type: 'field', inboundTag: ['api'], outboundTag: 'api' }];
  for (const i of db.inbounds.filter(x => x.enabled && x.core === 'xray')) {
    const o = usedOut(i); if (!o) continue;
    if (!outs.some(x => x.tag === 'out-' + o.id)) outs.push({ protocol: o.type, tag: 'out-' + o.id,
      settings: { servers: [{ address: o.host, port: o.port, ...(o.user ? { users: [{ user: o.user, pass: o.pass }] } : {}) }] } });
    rules.push({ type: 'field', inboundTag: ['in-' + i.id], outboundTag: 'out-' + o.id });
  }
  return { log: { loglevel: 'warning' }, api: { tag: 'api', services: ['StatsService'] }, stats: {},
    policy: { levels: { 0: { statsUserUplink: true, statsUserDownlink: true } } }, inbounds,
    outbounds: outs, routing: { rules } };
}
function buildSing() {
  const us = active(); if (!us.length) us.push(dummy());
  const inbounds = db.inbounds.filter(x => x.enabled && x.core === 'singbox').map(i => ({
    type: i.protocol, tag: 'in-' + i.id, listen: '127.0.0.1', listen_port: i.port,
    users: us.map(u => i.protocol === 'trojan' ? { name: u.id, password: u.uuid } : i.protocol === 'vmess' ? { name: u.id, uuid: u.uuid, alterId: 0 } : { name: u.id, uuid: u.uuid }),
    transport: { type: 'ws', path: i.path } }));
  const outs = [{ type: 'direct', tag: 'direct' }], rules = [];
  for (const i of db.inbounds.filter(x => x.enabled && x.core === 'singbox')) {
    const o = usedOut(i); if (!o) continue;
    if (!outs.some(x => x.tag === 'out-' + o.id)) outs.push({ type: o.type === 'http' ? 'http' : 'socks', tag: 'out-' + o.id, server: o.host, server_port: o.port,
      ...(o.type === 'socks' ? { version: '5' } : {}), ...(o.user ? { username: o.user, password: o.pass } : {}) });
    rules.push({ inbound: ['in-' + i.id], outbound: 'out-' + o.id });
  }
  return { log: { level: 'warn' }, inbounds, outbounds: outs, route: { rules, final: 'direct' } };
}
const cores = {
  xray: { bin: 'xray', args: c => ['run', '-c', c], build: buildXray, state: 'stopped', logs: [], proc: null, sig: '' },
  singbox: { bin: 'sing-box', args: c => ['run', '-c', c], build: buildSing, state: 'stopped', logs: [], proc: null, sig: '' },
};
const log = (c, d) => { c.logs.push(...String(d).split('\n').filter(Boolean).map(l => l.slice(0, 300))); c.logs = c.logs.slice(-200); };
function stopCore(c) { c.stopping = true; if (c.proc) { try { c.proc.kill(); } catch {} } c.proc = null; }
function startCore(name) {
  const c = cores[name]; stopCore(c);
  if (!db.inbounds.some(i => i.enabled && i.core === name)) { c.state = 'stopped'; return; }
  const cfg = path.join(DATA, name + '.json');
  fs.writeFileSync(cfg, JSON.stringify(c.build(), null, 1));
  c.sig = activeSig(); c.stopping = false; c.state = 'starting';
  const p = spawn(c.bin, c.args(cfg)); c.proc = p;
  p.stdout.on('data', d => log(c, d)); p.stderr.on('data', d => log(c, d));
  p.on('spawn', () => { c.state = 'running'; });
  p.on('error', e => { c.state = e.code === 'ENOENT' ? 'missing' : 'error'; log(c, e.message); });
  p.on('exit', code => { if (c.proc === p) { c.proc = null; if (!c.stopping) { c.state = 'crashed'; log(c, 'exit ' + code); setTimeout(() => startCore(name), 3000); } } });
}
const activeSig = () => active().map(u => u.id).join(',');
let t; const applyAll = () => { clearTimeout(t); t = setTimeout(() => { startCore('xray'); startCore('singbox'); }, 400); };

// آمار ترافیک کاربران (Xray) + بررسی انقضا/حجم
setInterval(() => {
  execFile('xray', ['api', 'statsquery', '--server=127.0.0.1:10085', '-reset'], { timeout: 8000 }, (err, out) => {
    if (!err) try {
      for (const s of JSON.parse(out).stat || []) {
        const [k, email, , dir] = s.name.split('>>>'); if (k !== 'user') continue;
        const u = db.users.find(x => x.id === email.split('@')[0]); if (u) u.used += +s.value || 0;
      }
    } catch {}
    for (const i of db.inbounds) { const b = flow.get(i.id) || 0; if (b) { i.bytes += b; flow.set(i.id, 0); } }
    save();
    if (activeSig() !== cores.xray.sig) applyAll();
  });
}, 20000);
const flow = new Map();

/* ---------- لینک‌ها ---------- */
const hostOf = req => (db.settings.publicHost || process.env.RAILWAY_PUBLIC_DOMAIN || req.headers.host || 'localhost').replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
function links(u, host) {
  const addr = db.settings.connectAddress || host, e = encodeURIComponent;
  return db.inbounds.filter(i => i.enabled).map(i => {
    const tag = `${i.name}-${u.name}`;
    let link;
    if (i.protocol === 'vmess') link = 'vmess://' + Buffer.from(JSON.stringify({ v: '2', ps: tag, add: addr, port: '443', id: u.uuid, aid: '0', scy: 'auto', net: 'ws', type: 'none', host, path: i.path, tls: 'tls', sni: host, fp: 'chrome' })).toString('base64');
    else if (i.protocol === 'trojan') link = `trojan://${u.uuid}@${addr}:443?security=tls&sni=${host}&fp=chrome&type=ws&host=${host}&path=${e(i.path)}#${e(tag)}`;
    else link = `vless://${u.uuid}@${addr}:443?encryption=none&security=tls&sni=${host}&fp=chrome&type=ws&host=${host}&path=${e(i.path)}#${e(tag)}`;
    return { name: i.name, core: i.core, link };
  });
}

/* ---------- احراز هویت ---------- */
const sign = s => crypto.createHmac('sha256', db.secret).update(s).digest('base64url');
const mkTok = () => { const p = Buffer.from(JSON.stringify({ exp: Date.now() + 7 * 864e5 })).toString('base64url'); return p + '.' + sign(p); };
function okTok(t) {
  if (!t) return false; const [p, s] = t.split('.'); if (!p || !s) return false;
  const e = sign(p); if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return false;
  try { return JSON.parse(Buffer.from(p, 'base64url')).exp > Date.now(); } catch { return false; }
}
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim().split('=')).filter(x => x[0]));
const tries = new Map();

/* ---------- HTTP ---------- */
const send = (res, code, obj, h = {}) => { const s = typeof obj === 'string'; res.writeHead(code, { 'content-type': s ? 'text/plain; charset=utf-8' : 'application/json', ...h }); res.end(s ? obj : JSON.stringify(obj)); };
const readBody = req => new Promise(ok => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); }); req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch { ok({}); } }); });
const pubUser = u => u;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname, m = req.method;
  try {
    if (p === '/' || p === '/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(__dirname, 'public/index.html'))); }
    if (p.startsWith('/sub/')) {
      const u = db.users.find(x => x.subToken === p.slice(5)); if (!u) return send(res, 404, 'not found');
      const ok = active().some(x => x.id === u.id), host = hostOf(req), now = Date.now();
      const ua = req.headers['user-agent'] || '';
      const browser = (req.headers.accept || '').includes('text/html') && !url.searchParams.has('raw') &&
        !/v2ray|clash|sing-box|hiddify|streisand|shadowrocket|nekobox|nekoray|happ|quantumult|surge|loon|stash|karing|flclash|curl|wget/i.test(ua);
      if (browser) {
        const data = { name: u.name, used: u.used, total: (u.limitGB || 0) * 1e9, expireAt: u.expireAt || 0, sub: `https://${host}/sub/${u.subToken}`,
          status: !u.enabled ? 'disabled' : (u.expireAt && u.expireAt <= now) ? 'expired' : (u.limitGB && u.used >= u.limitGB * 1e9) ? 'limit' : 'active',
          links: ok ? links(u, host) : [] };
        const html = fs.readFileSync(path.join(__dirname, 'public/sub.html'), 'utf8').replace('__DATA__', () => JSON.stringify(data).replace(/</g, '\\u003c'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(html);
      }
      return send(res, 200, Buffer.from(ok ? links(u, host).map(l => l.link).join('\n') : '').toString('base64'), {
        'subscription-userinfo': `upload=0; download=${u.used}; total=${(u.limitGB || 0) * 1e9}; expire=${Math.floor((u.expireAt || 0) / 1000)}`, 'profile-title': 'MEOPANEL' });
    }
    if (!p.startsWith('/api/')) return send(res, 404, 'not found');

    if (p === '/api/hint') return send(res, 200, { first: !!db.admin.mustChange });
    if (p === '/api/login' && m === 'POST') {
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress, tr = tries.get(ip) || { n: 0, t: Date.now() };
      if (Date.now() - tr.t > 6e5) { tr.n = 0; tr.t = Date.now(); }
      if (tr.n >= 8) return send(res, 429, { error: 'تلاش بیش از حد؛ چند دقیقه بعد دوباره امتحان کنید' });
      const b = await readBody(req), good = b.username === db.admin.user && crypto.timingSafeEqual(Buffer.from(pbk(String(b.password || ''), db.admin.salt)), Buffer.from(db.admin.hash));
      if (!good) { tr.n++; tries.set(ip, tr); return send(res, 401, { error: 'نام کاربری یا رمز عبور اشتباه است' }); }
      const sec = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      return send(res, 200, { ok: true }, { 'set-cookie': `meo=${mkTok()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${sec}` });
    }
    if (!okTok(cookie(req).meo)) return send(res, 401, { error: 'unauthorized' });
    if (db.admin.mustChange && !['/api/password', '/api/logout', '/api/overview'].includes(p)) return send(res, 403, { error: 'ابتدا رمز عبور را تغییر دهید', mustChange: true });
    const b = ['POST', 'PUT'].includes(m) ? await readBody(req) : {};
    let r;

    if (p === '/api/logout') return send(res, 200, { ok: true }, { 'set-cookie': 'meo=; Path=/; Max-Age=0' });
    if (p === '/api/overview') {
      const act = active();
      return send(res, 200, { users: db.users.length, active: act.length, inbounds: db.inbounds.length, used: db.users.reduce((a, u) => a + u.used, 0),
        inboundBytes: db.inbounds.reduce((a, i) => a + i.bytes + (flow.get(i.id) || 0), 0), cores: Object.fromEntries(Object.entries(cores).map(([k, c]) => [k, c.state])), host: hostOf(req), mustChange: !!db.admin.mustChange });
    }
    if (p === '/api/cores') return send(res, 200, Object.fromEntries(Object.entries(cores).map(([k, c]) => [k, { state: c.state, logs: c.logs.slice(-60) }])));
    if ((r = p.match(/^\/api\/cores\/(xray|singbox)\/restart$/)) && m === 'POST') { startCore(r[1]); return send(res, 200, { ok: true }); }

    if (p === '/api/settings') {
      if (m === 'PUT') { db.settings.publicHost = String(b.publicHost || '').trim(); db.settings.connectAddress = String(b.connectAddress || '').trim(); save(); }
      return send(res, 200, db.settings);
    }
    if (p === '/api/password' && m === 'POST') {
      const cur = Buffer.from(pbk(String(b.current || ''), db.admin.salt)), real = Buffer.from(db.admin.hash);
      if (cur.length !== real.length || !crypto.timingSafeEqual(cur, real)) return send(res, 400, { error: 'رمز فعلی اشتباه است' });
      const np = String(b.password || '');
      if (np.length < 6) return send(res, 400, { error: 'رمز جدید باید حداقل ۶ کاراکتر باشد' });
      if (np === 'admin') return send(res, 400, { error: 'رمز جدید نباید admin باشد' });
      if (b.username) db.admin.user = String(b.username).trim().slice(0, 32);
      db.admin.salt = rid(8); db.admin.hash = pbk(np, db.admin.salt); db.admin.mustChange = false;
      db.secret = rid(24); save(); // همه‌ی نشست‌های قبلی باطل می‌شوند
      return send(res, 200, { ok: true }, { 'set-cookie': 'meo=; Path=/; Max-Age=0' });
    }

    /* کاربران */
    if (p === '/api/users' && m === 'GET') return send(res, 200, db.users.map(pubUser));
    if (p === '/api/users' && m === 'POST') { const u = newUser(b); db.users.push(u); save(); applyAll(); return send(res, 200, u); }
    if ((r = p.match(/^\/api\/users\/(\w+)(\/links|\/reset)?$/))) {
      const u = db.users.find(x => x.id === r[1]); if (!u) return send(res, 404, { error: 'کاربر پیدا نشد' });
      if (r[2] === '/links') { const h = hostOf(req); return send(res, 200, { sub: `https://${h}/sub/${u.subToken}`, links: links(u, h) }); }
      if (r[2] === '/reset') { u.used = 0; save(); applyAll(); return send(res, 200, u); }
      if (m === 'PUT') {
        if ('name' in b) u.name = String(b.name).slice(0, 40); if ('enabled' in b) u.enabled = !!b.enabled;
        if ('limitGB' in b) u.limitGB = +b.limitGB || 0; if ('days' in b) u.expireAt = +b.days ? Date.now() + b.days * 864e5 : 0; if ('note' in b) u.note = String(b.note);
        save(); applyAll(); return send(res, 200, u);
      }
      if (m === 'DELETE') { db.users = db.users.filter(x => x !== u); save(); applyAll(); return send(res, 200, { ok: true }); }
    }


    /* پروکسی‌های خروجی (IP پروکسی) */
    if (p === '/api/outbounds' && m === 'GET') return send(res, 200, db.outbounds.map(o => ({ ...o, pass: o.pass ? '••••' : '' })));
    if (p === '/api/outbounds' && m === 'POST') {
      let o = b;
      if (b.url) { try { const u = new URL(String(b.url).trim()); const t = u.protocol.startsWith('socks') ? 'socks' : u.protocol.startsWith('http') ? 'http' : '';
        if (!t) throw 0; o = { name: b.name, type: t, host: u.hostname, port: +u.port, user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) }; } catch { return send(res, 400, { error: 'فرمت لینک پروکسی درست نیست (مثال: socks5://user:pass@1.2.3.4:1080)' }); } }
      const port = +o.port;
      if (!['socks', 'http'].includes(o.type) || !o.host || !(port > 0 && port < 65536)) return send(res, 400, { error: 'نوع، آدرس و پورت پروکسی را درست وارد کنید' });
      const n = { id: rid(4), name: String(o.name || o.host).slice(0, 40), type: o.type, host: String(o.host).trim(), port, user: String(o.user || ''), pass: String(o.pass || ''), enabled: true };
      db.outbounds.push(n); save(); return send(res, 200, { ...n, pass: n.pass ? '••••' : '' });
    }
    if ((r = p.match(/^\/api\/outbounds\/(\w+)(\/test)?$/))) {
      const o = db.outbounds.find(x => x.id === r[1]); if (!o) return send(res, 404, { error: 'پروکسی پیدا نشد' });
      if (r[2]) { const t0 = Date.now(); return new Promise(done => { const c = net.connect({ host: o.host, port: o.port, timeout: 6000 }, () => { c.destroy(); done(send(res, 200, { ok: true, ms: Date.now() - t0 })); });
        c.on('error', () => done(send(res, 200, { ok: false }))); c.on('timeout', () => { c.destroy(); done(send(res, 200, { ok: false })); }); }); }
      if (m === 'PUT') { if ('enabled' in b) o.enabled = !!b.enabled; save(); applyAll(); return send(res, 200, { ok: true }); }
      if (m === 'DELETE') { db.outbounds = db.outbounds.filter(x => x !== o); db.inbounds.forEach(i => { if (i.outbound === o.id) i.outbound = ''; }); save(); applyAll(); return send(res, 200, { ok: true }); }
    }

    /* اینباندها */
    if (p === '/api/inbounds' && m === 'GET') return send(res, 200, db.inbounds.map(i => ({ ...i, bytes: i.bytes + (flow.get(i.id) || 0) })));
    if (p === '/api/inbounds' && m === 'POST') {
      const core = b.core === 'singbox' ? 'singbox' : 'xray', protocol = ['vless', 'vmess', 'trojan'].includes(b.protocol) ? b.protocol : 'vless';
      const port = +b.port || Math.max(20000, ...db.inbounds.map(i => i.port)) + 1;
      if (db.inbounds.some(i => i.port === port)) return send(res, 400, { error: 'این پورت قبلاً استفاده شده' });
      let pth = String(b.path || '/' + rid(5)); if (!pth.startsWith('/')) pth = '/' + pth;
      if (db.inbounds.some(i => i.path === pth) || pth.startsWith('/api') || pth.startsWith('/sub')) return send(res, 400, { error: 'این مسیر قابل استفاده نیست' });
      const i = { id: rid(4), name: String(b.name || `${core} ${protocol}`).slice(0, 40), core, protocol, port, path: pth, enabled: true, bytes: 0, outbound: db.outbounds.some(o => o.id === b.outbound) ? b.outbound : '' };
      db.inbounds.push(i); save(); applyAll(); return send(res, 200, i);
    }
    if ((r = p.match(/^\/api\/inbounds\/(\w+)$/))) {
      const i = db.inbounds.find(x => x.id === r[1]); if (!i) return send(res, 404, { error: 'اینباند پیدا نشد' });
      if (m === 'PUT') { if ('enabled' in b) i.enabled = !!b.enabled; if (b.name) i.name = String(b.name).slice(0, 40); if ('outbound' in b) i.outbound = db.outbounds.some(o => o.id === b.outbound) ? b.outbound : ''; save(); applyAll(); return send(res, 200, i); }
      if (m === 'DELETE') { db.inbounds = db.inbounds.filter(x => x !== i); save(); applyAll(); return send(res, 200, { ok: true }); }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { console.error(e); send(res, 500, { error: 'خطای داخلی' }); }
});

// پروکسی WebSocket: دامنه‌ی Railway فقط یک پورت دارد، پس ترافیک هر مسیر به هسته‌ی مربوط می‌رود
server.on('upgrade', (req, socket, head) => {
  const i = db.inbounds.find(x => x.enabled && x.path === req.url.split('?')[0]);
  if (!i || cores[i.core].state !== 'running') return socket.destroy();
  const up = net.connect(i.port, '127.0.0.1', () => {
    let h = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let k = 0; k < req.rawHeaders.length; k += 2) h += `${req.rawHeaders[k]}: ${req.rawHeaders[k + 1]}\r\n`;
    up.write(h + '\r\n'); if (head && head.length) up.write(head);
    socket.pipe(up); up.pipe(socket);
  });
  const count = d => flow.set(i.id, (flow.get(i.id) || 0) + d.length);
  socket.on('data', count); up.on('data', count);
  up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy());
  socket.on('close', () => up.destroy()); up.on('close', () => socket.destroy());
});

server.listen(PORT, '0.0.0.0', () => { console.log('MEOPANEL listening on', PORT); applyAll(); });
process.on('SIGTERM', () => { Object.values(cores).forEach(stopCore); save(); process.exit(0); });
