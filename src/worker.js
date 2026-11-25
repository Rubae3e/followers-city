// مدينة المتابعين — السيرفر (Cloudflare Worker + D1)
// ManyChat يطلب /api/join عند كل تعليق، والموقع يقرأ /api/city

const COLORS = 8;           // عدد ألوان البيوت المتاحة بالموقع
const LV = c => c >= 7 ? 3 : c >= 3 ? 2 : 1;   // عدد الطوابق حسب عدد التعليقات

const J = (o, s = 200, extra = {}) => new Response(JSON.stringify(o), {
  status: s,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra }
});

function newToken() {
  const a = new Uint8Array(18);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function cleanUser(v) {
  const u = String(v || '').trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(u) ? u : null;
}

function cleanText(v, max) {
  return String(v || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
}

function publicResident(r) {
  let h = {};
  try { h = JSON.parse(r.house || '{}'); } catch (e) {}
  let owned = [];
  try { owned = JSON.parse(r.owned || '[]'); } catch (e) {}
  return { no: r.id, n: r.username, d: r.name || '', t: r.created, c: r.comments, h, rs: r.roses || 0, o: owned };
}

// ---------- اقتصاد المدينة ----------
const SHOP = {
  lantern: 50, oud: 80, orange: 120, aquarium: 150, car: 150, chandelier: 200, fountain: 250, floor_plus: 400
};
const REWARDS = [10, 15, 20, 30, 40, 60, 100];
const BASIC = ['sofa', 'tv', 'carpet', 'shelf', 'plant', 'samovar', 'frame', 'table', 'lamp'];
const INSIDE_RARE = ['lantern', 'oud', 'orange', 'aquarium', 'chandelier', 'fountain'];
const bgDay = (offsetDays = 0) => new Date(Date.now() + 3 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);
const LIMITS = { chandelier: 10, fountain: 5, aquarium: 10, floor_plus: 5, car: 15 };
function weekKey() {
  const d = new Date(Date.now() + 3 * 3600e3); const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day); return d.toISOString().slice(0, 10);
}
async function stockLeft(env) {
  const { results } = await env.DB.prepare('SELECT item, COUNT(*) AS c FROM purchases WHERE week = ? GROUP BY item').bind(weekKey()).all();
  const used = Object.fromEntries(results.map(x => [x.item, x.c]));
  return Object.fromEntries(Object.entries(LIMITS).map(([k, v]) => [k, Math.max(0, v - (used[k] || 0))]));
}
function stripItem(r, item) {
  // remove an item from owned and from the interior layout
  const own = ownedOf(r).filter(x => x !== item);
  let h = {}; try { h = JSON.parse(r.house || '{}'); } catch (e) {}
  if (h.inside && Array.isArray(h.inside.items)) h.inside.items = h.inside.items.filter(it => it.k !== item);
  return { own, house: JSON.stringify(h) };
}
function ownedOf(r) { try { return JSON.parse(r.owned || '[]'); } catch (e) { return []; } }
async function meFull(env, r) {
  const today = bgDay();
  const { results: vis } = await env.DB.prepare(
    `SELECT r.username AS n, x.day FROM roses x JOIN residents r ON r.id = x.from_id WHERE x.to_id = ? ORDER BY x.id DESC LIMIT 6`
  ).bind(r.id).all();
  const given = await env.DB.prepare('SELECT COUNT(*) AS c FROM roses WHERE from_id = ? AND day = ?').bind(r.id, today).first();
  const { results: gaveTo } = await env.DB.prepare('SELECT to_id FROM roses WHERE from_id = ? AND day = ?').bind(r.id, today).all();
  const { results: myListings } = await env.DB.prepare("SELECT id, item, price FROM listings WHERE seller_id = ? AND status = 'open' ORDER BY id DESC").bind(r.id).all();
  return { ...publicResident(r), myListings, coins: r.coins || 0, streak: r.streak || 0, canClaim: r.last_claim !== today, streakAlive: r.last_claim === bgDay(-1),
    visitors: vis, rosesLeft: Math.max(0, 20 - (given?.c || 0)), gaveTo: gaveTo.map(x => x.to_id) };
}
async function byToken(env, t) {
  return t ? env.DB.prepare('SELECT * FROM residents WHERE token = ?').bind(String(t)).first() : null;
}

let SITE = '';
function linkFor(env, r) {
  return `${(env.SITE_URL || SITE).replace(/\/$/, '')}/?t=${r.token}`;
}

let ready = false;
async function ensureTable(env) {
  if (ready) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS residents (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, ig_id TEXT, name TEXT,
    token TEXT NOT NULL UNIQUE, created TEXT NOT NULL, comments INTEGER NOT NULL DEFAULT 1,
    house TEXT NOT NULL DEFAULT '{}', coins INTEGER NOT NULL DEFAULT 0, streak INTEGER NOT NULL DEFAULT 0,
    last_claim TEXT, roses INTEGER NOT NULL DEFAULT 0, owned TEXT NOT NULL DEFAULT '[]')`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS roses (id INTEGER PRIMARY KEY AUTOINCREMENT, from_id INTEGER NOT NULL,
    to_id INTEGER NOT NULL, day TEXT NOT NULL, at TEXT NOT NULL, UNIQUE(from_id, to_id, day))`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS purchases (id INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT NOT NULL,
    buyer_id INTEGER NOT NULL, week TEXT NOT NULL, at TEXT NOT NULL)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS listings (id INTEGER PRIMARY KEY AUTOINCREMENT, seller_id INTEGER NOT NULL,
    item TEXT NOT NULL, price INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', buyer_id INTEGER, created TEXT NOT NULL, sold_at TEXT)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, path TEXT, status INTEGER, note TEXT)`).run();
  ready = true;
}

function isManyChat(req, env) {
  const h = req.headers.get('x-city-secret');
  return !!env.CITY_SECRET && h != null && h.trim() === env.CITY_SECRET.trim();
}

async function body(req) {
  const t = await req.text().catch(() => '');
  req._raw = t;
  try { return JSON.parse(t); } catch (e) { return {}; }
}

async function log(env, path, status, note) {
  try {
    await env.DB.prepare('INSERT INTO logs (at, path, status, note) VALUES (?, ?, ?, ?)')
      .bind(new Date().toISOString(), path, status, String(note).slice(0, 300)).run();
    await env.DB.prepare('DELETE FROM logs WHERE id <= (SELECT MAX(id) - 200 FROM logs)').run();
  } catch (e) {}
}

function secretNote(req, env) {
  const h = req.headers.get('x-city-secret');
  if (!env.CITY_SECRET) return 'server secret not set';
  if (h == null) return 'header missing';
  if (h !== env.CITY_SECRET) return `header mismatch (len ${h.length} vs ${env.CITY_SECRET.length}, trimmed ${h.trim() === env.CITY_SECRET.trim() ? 'matches' : 'differs'})`;
  return 'ok';
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (!p.startsWith('/api/')) return env.ASSETS.fetch(req);

    SITE = url.origin;
    try {
      await ensureTable(env);
      // ---------- ManyChat: معلّق جديد أو تعليق جديد ----------
      if (p === '/api/join' && req.method === 'POST') {
        const b = await body(req);
        if (!isManyChat(req, env)) { await log(env, p, 403, secretNote(req, env)); return J({ error: 'forbidden' }, 403); }
        const u = cleanUser(b.username);
        if (!u) { await log(env, p, 400, 'bad username; body: ' + req._raw); return J({ error: 'bad username' }, 400); }
        const name = cleanText(b.name, 40);
        const today = new Date().toISOString().slice(0, 10);

        let r = await env.DB.prepare(
          `INSERT INTO residents (username, ig_id, name, token, created, comments, house)
           VALUES (?, ?, ?, ?, ?, 1, '{}')
           ON CONFLICT(username) DO NOTHING RETURNING *`
        ).bind(u, cleanText(b.ig_id, 40), name, newToken(), today).first();

        let isNew = !!r, levelUp = false;
        if (!r) {
          r = await env.DB.prepare(
            'UPDATE residents SET comments = comments + 1 WHERE username = ? RETURNING *'
          ).bind(u).first();
          levelUp = LV(r.comments) > LV(r.comments - 1);
        }
        await log(env, p, 200, `${u} new=${isNew}`);
        return J({
          is_new: isNew ? 'yes' : 'no',
          level_up: levelUp ? 'yes' : 'no',
          house_no: String(r.id),
          floors: String(LV(r.comments)),
          comments: String(r.comments),
          link: linkFor(env, r)
        });
      }

      // ---------- ManyChat: المتابع ضيّع الرابط ودز «بيتي» ----------
      if (p === '/api/link' && req.method === 'POST') {
        if (!isManyChat(req, env)) return J({ error: 'forbidden' }, 403);
        const u = cleanUser((await body(req)).username);
        const r = u && await env.DB.prepare('SELECT * FROM residents WHERE username = ?').bind(u).first();
        if (!r) return J({ found: 'no', link: env.SITE_URL || SITE });
        return J({ found: 'yes', house_no: String(r.id), link: linkFor(env, r) });
      }

      // ---------- الموقع: كل سكان المدينة ----------
      if (p === '/api/city' && req.method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT id, username, name, created, comments, house, roses, owned FROM residents ORDER BY id'
        ).all();
        return J({ people: results.map(publicResident) }, 200, { 'cache-control': 'public, max-age=20' });
      }

      // ---------- الموقع: منو آني (برابط الدخول) ----------
      if (p === '/api/me' && req.method === 'GET') {
        const t = url.searchParams.get('t') || '';
        const r = t && await env.DB.prepare('SELECT * FROM residents WHERE token = ?').bind(t).first();
        if (!r) return J({ error: 'not found' }, 404);
        return J({ me: await meFull(env, r) });
      }

      // ---------- الموقع: صاحب البيت يعدّل بيته ----------
      if (p === '/api/house' && req.method === 'POST') {
        const b = await body(req);
        const r = b.t && await env.DB.prepare('SELECT * FROM residents WHERE token = ?').bind(String(b.t)).first();
        if (!r) return J({ error: 'not found' }, 404);
        const color = Math.max(0, Math.min(COLORS - 1, parseInt(b.color, 10) || 0));
        let old = {};
        try { old = JSON.parse(r.house || '{}'); } catch (e) {}
        const house = {
          ...(old.inside ? { inside: old.inside } : {}),
          color,
          roof: b.roof === 'pitched' ? 'pitched' : 'flat',
          tree: b.tree === 'tree' ? 'tree' : 'palm',
          msg: cleanText(b.msg, 60)
        };
        await env.DB.prepare('UPDATE residents SET house = ? WHERE id = ?').bind(JSON.stringify(house), r.id).run();
        return J({ ok: true, me: publicResident({ ...r, house: JSON.stringify(house) }) });
      }

      // ---------- الموقع: صاحب البيت يرتب داخل بيته ----------
      if (p === '/api/inside' && req.method === 'POST') {
        const b = await body(req);
        const r = b.t && await env.DB.prepare('SELECT * FROM residents WHERE token = ?').bind(String(b.t)).first();
        if (!r) return J({ error: 'not found' }, 404);
        const own = ownedOf(r);
        const TYPES = BASIC.concat(INSIDE_RARE.filter(k => own.includes(k)));
        const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n * 10) / 10)) : 0; };
        const items = (Array.isArray(b.items) ? b.items : []).slice(0, 40)
          .filter(it => it && TYPES.includes(it.k))
          .map(it => ({ k: it.k, x: num(it.x, -4.3, 4.3), z: num(it.z, -4.3, 4.3), r: Math.max(0, Math.min(3, parseInt(it.r, 10) || 0)) }));
        let h = {};
        try { h = JSON.parse(r.house || '{}'); } catch (e) {}
        h.inside = { wall: Math.max(0, Math.min(7, parseInt(b.wall, 10) || 0)), floor: Math.max(0, Math.min(3, parseInt(b.floor, 10) || 0)), items };
        await env.DB.prepare('UPDATE residents SET house = ? WHERE id = ?').bind(JSON.stringify(h), r.id).run();
        return J({ ok: true, me: publicResident({ ...r, house: JSON.stringify(h) }) });
      }

      // ---------- الهدية اليومية ----------
      if (p === '/api/claim' && req.method === 'POST') {
        const r = await byToken(env, (await body(req)).t);
        if (!r) return J({ error: 'not found' }, 404);
        const today = bgDay(), yday = bgDay(-1);
        if (r.last_claim === today) return J({ error: 'already', me: await meFull(env, r) }, 409);
        const streak = r.last_claim === yday ? (r.streak || 0) + 1 : 1;
        const reward = REWARDS[Math.min(streak, 7) - 1];
        const u = await env.DB.prepare('UPDATE residents SET coins = coins + ?, streak = ?, last_claim = ? WHERE id = ? AND (last_claim IS NULL OR last_claim <> ?) RETURNING *')
          .bind(reward, streak, today, r.id, today).first();
        if (!u) return J({ error: 'already' }, 409);
        return J({ ok: true, reward, streak, me: await meFull(env, u) });
      }

      // ---------- إهداء وردة ----------
      if (p === '/api/rose' && req.method === 'POST') {
        const b = await body(req);
        const r = await byToken(env, b.t);
        if (!r) return J({ error: 'not found' }, 404);
        const to = parseInt(b.to, 10);
        if (!to || to === r.id) return J({ error: 'bad target' }, 400);
        const target = await env.DB.prepare('SELECT id FROM residents WHERE id = ?').bind(to).first();
        if (!target) return J({ error: 'bad target' }, 400);
        const today = bgDay();
        const given = await env.DB.prepare('SELECT COUNT(*) AS c FROM roses WHERE from_id = ? AND day = ?').bind(r.id, today).first();
        if ((given?.c || 0) >= 20) return J({ error: 'limit' }, 429);
        const ins = await env.DB.prepare('INSERT INTO roses (from_id, to_id, day, at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id')
          .bind(r.id, to, today, new Date().toISOString()).first();
        if (!ins) return J({ error: 'already' }, 409);
        await env.DB.batch([
          env.DB.prepare('UPDATE residents SET coins = coins + 5 WHERE id = ?').bind(r.id),
          env.DB.prepare('UPDATE residents SET coins = coins + 5, roses = roses + 1 WHERE id = ?').bind(to)
        ]);
        const fresh = await env.DB.prepare('SELECT * FROM residents WHERE id = ?').bind(r.id).first();
        const tr = await env.DB.prepare('SELECT roses FROM residents WHERE id = ?').bind(to).first();
        return J({ ok: true, me: await meFull(env, fresh), toRoses: tr.roses });
      }

      // ---------- السوق ----------
      if (p === '/api/buy' && req.method === 'POST') {
        const b = await body(req);
        const r = await byToken(env, b.t);
        if (!r) return J({ error: 'not found' }, 404);
        const item = String(b.item || '');
        const price = SHOP[item];
        if (!price) return J({ error: 'bad item' }, 400);
        const own = ownedOf(r);
        if (own.includes(item)) return J({ error: 'owned' }, 409);
        if (LIMITS[item] && (await stockLeft(env))[item] <= 0) return J({ error: 'sold_out' }, 410);
        own.push(item);
        const u = await env.DB.prepare('UPDATE residents SET coins = coins - ?, owned = ? WHERE id = ? AND coins >= ? RETURNING *')
          .bind(price, JSON.stringify(own), r.id, price).first();
        if (!u) return J({ error: 'poor' }, 402);
        if (LIMITS[item]) await env.DB.prepare('INSERT INTO purchases (item, buyer_id, week, at) VALUES (?, ?, ?, ?)').bind(item, r.id, weekKey(), new Date().toISOString()).run();
        return J({ ok: true, me: await meFull(env, u) });
      }

      // ---------- بيع قطعة للمدينة بنص السعر ----------
      if (p === '/api/sell' && req.method === 'POST') {
        const b = await body(req);
        const r = await byToken(env, b.t);
        if (!r) return J({ error: 'not found' }, 404);
        const item = String(b.item || '');
        if (!SHOP[item] || !ownedOf(r).includes(item)) return J({ error: 'not owned' }, 400);
        const back = Math.floor(SHOP[item] / 2);
        const { own, house } = stripItem(r, item);
        const u = await env.DB.prepare('UPDATE residents SET coins = coins + ?, owned = ?, house = ? WHERE id = ? AND owned = ? RETURNING *')
          .bind(back, JSON.stringify(own), house, r.id, r.owned).first();
        if (!u) return J({ error: 'retry' }, 409);
        return J({ ok: true, got: back, me: await meFull(env, u) });
      }

      // ---------- سوگ الجمعة: عرض قطعة ----------
      if (p === '/api/list' && req.method === 'POST') {
        const b = await body(req);
        const r = await byToken(env, b.t);
        if (!r) return J({ error: 'not found' }, 404);
        const item = String(b.item || ''), price = parseInt(b.price, 10);
        if (!SHOP[item] || !ownedOf(r).includes(item)) return J({ error: 'not owned' }, 400);
        if (!(price >= 10 && price <= 5000)) return J({ error: 'bad price' }, 400);
        const { own, house } = stripItem(r, item);
        const u = await env.DB.prepare('UPDATE residents SET owned = ?, house = ? WHERE id = ? AND owned = ? RETURNING *')
          .bind(JSON.stringify(own), house, r.id, r.owned).first();
        if (!u) return J({ error: 'retry' }, 409);
        await env.DB.prepare('INSERT INTO listings (seller_id, item, price, created) VALUES (?, ?, ?, ?)').bind(r.id, item, price, new Date().toISOString()).run();
        return J({ ok: true, me: await meFull(env, u) });
      }

      // ---------- سوگ الجمعة: سحب العرض ----------
      if (p === '/api/unlist' && req.method === 'POST') {
        const b = await body(req);
        const r = await byToken(env, b.t);
        if (!r) return J({ error: 'not found' }, 404);
        const l = await env.DB.prepare("UPDATE listings SET status = 'cancelled' WHERE id = ? AND seller_id = ? AND status = 'open' RETURNING *").bind(parseInt(b.id, 10), r.id).first();
        if (!l) return J({ error: 'gone' }, 409);
        const fresh = await env.DB.prepare('SELECT * FROM residents WHERE id = ?').bind(r.id).first();
        const own = ownedOf(fresh); if (!own.includes(l.item)) own.push(l.item);
        const u = await env.DB.prepare('UPDATE residents SET owned = ? WHERE id = ? RETURNING *').bind(JSON.stringify(own), r.id).first();
        return J({ ok: true, me: await meFull(env, u) });
      }

      // ---------- سوگ الجمعة: شراء من ساكن ----------
      if (p === '/api/market/buy' && req.method === 'POST') {
        const b = await body(req);
        const r = await byToken(env, b.t);
        if (!r) return J({ error: 'not found' }, 404);
        const l = await env.DB.prepare("SELECT * FROM listings WHERE id = ? AND status = 'open'").bind(parseInt(b.id, 10)).first();
        if (!l) return J({ error: 'gone' }, 409);
        if (l.seller_id === r.id) return J({ error: 'own listing' }, 400);
        if (ownedOf(r).includes(l.item)) return J({ error: 'owned' }, 409);
        const paid = await env.DB.prepare('UPDATE residents SET coins = coins - ? WHERE id = ? AND coins >= ? RETURNING id').bind(l.price, r.id, l.price).first();
        if (!paid) return J({ error: 'poor' }, 402);
        const sold = await env.DB.prepare("UPDATE listings SET status = 'sold', buyer_id = ?, sold_at = ? WHERE id = ? AND status = 'open' RETURNING *")
          .bind(r.id, new Date().toISOString(), l.id).first();
        if (!sold) { await env.DB.prepare('UPDATE residents SET coins = coins + ? WHERE id = ?').bind(l.price, r.id).run(); return J({ error: 'gone' }, 409); }
        await env.DB.prepare('UPDATE residents SET coins = coins + ? WHERE id = ?').bind(l.price, l.seller_id).run();
        const fresh = await env.DB.prepare('SELECT * FROM residents WHERE id = ?').bind(r.id).first();
        const own = ownedOf(fresh); if (!own.includes(l.item)) own.push(l.item);
        const u = await env.DB.prepare('UPDATE residents SET owned = ? WHERE id = ? RETURNING *').bind(JSON.stringify(own), r.id).first();
        return J({ ok: true, me: await meFull(env, u) });
      }

      // ---------- سوگ الجمعة: العروض والمخزون ----------
      if (p === '/api/market' && req.method === 'GET') {
        const { results } = await env.DB.prepare(
          "SELECT l.id, l.item, l.price, l.seller_id AS sno, r.username AS seller FROM listings l JOIN residents r ON r.id = l.seller_id WHERE l.status = 'open' ORDER BY l.id DESC LIMIT 60"
        ).all();
        return J({ listings: results, stock: await stockLeft(env) });
      }

      // ---------- لوحة الشرف ----------
      if (p === '/api/top' && req.method === 'GET') {
        const since = bgDay(-6);
        const { results: loved } = await env.DB.prepare(
          `SELECT r.id AS no, r.username AS n, COUNT(*) AS c FROM roses x JOIN residents r ON r.id = x.to_id WHERE x.day >= ? GROUP BY x.to_id ORDER BY c DESC LIMIT 5`
        ).bind(since).all();
        const { results: givers } = await env.DB.prepare(
          `SELECT r.id AS no, r.username AS n, COUNT(*) AS c FROM roses x JOIN residents r ON r.id = x.from_id WHERE x.day >= ? GROUP BY x.from_id ORDER BY c DESC LIMIT 5`
        ).bind(since).all();
        return J({ loved, givers }, 200, { 'cache-control': 'public, max-age=30' });
      }

      // ---------- إلك انت: حذف ساكن مسيء ----------
      if (p === '/api/admin/remove' && req.method === 'POST') {
        if (!isManyChat(req, env)) return J({ error: 'forbidden' }, 403);
        const u = cleanUser((await body(req)).username);
        if (!u) return J({ error: 'bad username' }, 400);
        await env.DB.prepare('DELETE FROM residents WHERE username = ?').bind(u).run();
        return J({ ok: true });
      }

      return J({ error: 'not found' }, 404);
    } catch (e) {
      return J({ error: 'server error' }, 500);
    }
  }
};
