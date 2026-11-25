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
  return { no: r.id, n: r.username, d: r.name || '', t: r.created, c: r.comments, h };
}

function linkFor(env, r) {
  return `${env.SITE_URL.replace(/\/$/, '')}/?t=${r.token}`;
}

function isManyChat(req, env) {
  return env.CITY_SECRET && req.headers.get('x-city-secret') === env.CITY_SECRET;
}

async function body(req) {
  return req.json().catch(() => ({}));
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (!p.startsWith('/api/')) return env.ASSETS.fetch(req);

    try {
      // ---------- ManyChat: معلّق جديد أو تعليق جديد ----------
      if (p === '/api/join' && req.method === 'POST') {
        if (!isManyChat(req, env)) return J({ error: 'forbidden' }, 403);
        const b = await body(req);
        const u = cleanUser(b.username);
        if (!u) return J({ error: 'bad username' }, 400);
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
        if (!r) return J({ found: 'no', link: env.SITE_URL });
        return J({ found: 'yes', house_no: String(r.id), link: linkFor(env, r) });
      }

      // ---------- الموقع: كل سكان المدينة ----------
      if (p === '/api/city' && req.method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT id, username, name, created, comments, house FROM residents ORDER BY id'
        ).all();
        return J({ people: results.map(publicResident) }, 200, { 'cache-control': 'public, max-age=20' });
      }

      // ---------- الموقع: منو آني (برابط الدخول) ----------
      if (p === '/api/me' && req.method === 'GET') {
        const t = url.searchParams.get('t') || '';
        const r = t && await env.DB.prepare('SELECT * FROM residents WHERE token = ?').bind(t).first();
        if (!r) return J({ error: 'not found' }, 404);
        return J({ me: publicResident(r) });
      }

      // ---------- الموقع: صاحب البيت يعدّل بيته ----------
      if (p === '/api/house' && req.method === 'POST') {
        const b = await body(req);
        const r = b.t && await env.DB.prepare('SELECT * FROM residents WHERE token = ?').bind(String(b.t)).first();
        if (!r) return J({ error: 'not found' }, 404);
        const color = Math.max(0, Math.min(COLORS - 1, parseInt(b.color, 10) || 0));
        const house = {
          color,
          roof: b.roof === 'pitched' ? 'pitched' : 'flat',
          tree: b.tree === 'tree' ? 'tree' : 'palm',
          msg: cleanText(b.msg, 60)
        };
        await env.DB.prepare('UPDATE residents SET house = ? WHERE id = ?').bind(JSON.stringify(house), r.id).run();
        return J({ ok: true, me: publicResident({ ...r, house: JSON.stringify(house) }) });
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
