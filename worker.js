// 統合アプリ（tougouban48）Worker
// - 静的ファイル（Claude用/）の配信（/api/ 以外は、そのまま静的ファイルが返る）
// - 「文章の編集」を保存する API（Cloudflare KV）
//
// 【データの考え方】
//  KVの 'tougouban-text-overrides' に、編集した文章だけを1つのキーで保存している。
//   { "<辞書の場所を表すキー>": "編集後の文章", ... }
//  元の文章はコード（index.html）の中に残っているので、ここから消せば元に戻る。
//
// 【事故防止の仕組み】
//  1. 書き込みの直前に、いまの内容を自動でバックアップする（直近30件）
//  2. 追加・更新・削除は「1か所単位の操作」（/api/texts/set, /api/texts/reset）で行い、
//     古い全体データで丸ごと上書きしてしまう事故が起きないようにする
//
// 認証なし。誰でも読み書きできる共有データベース（友達データ帳と同じ考え方）。
// KVは友達データ帳と同じ名前空間を使うが、キー名が別なので互いに影響しない。
//
// 【API】
//  GET  /api/texts          … 編集した文章の一覧  { items: { key: text, ... }, updatedAt }
//  POST /api/texts/set      … 追加・更新。body: { items: { key: text, ... } }
//  POST /api/texts/reset    … 元に戻す。body: { keys: [key, ...] }  または { all: true }
//  GET  /api/texts/backups  … バックアップ一覧
//  POST /api/texts/restore  … バックアップから復元。body: { key: "..." }
//
// 【AI鑑定文のマーカー】（ハウスパネルの「✨ AI鑑定」に引いたマーカー）
//  鑑定文の組み合わせごとに、KVの別々のキー（'tougouban-mark:<key>'）で保存する。
//  1件ずつ独立しているので、ほかのマーカーを巻き込んで上書きすることがない。
//  書き込みの直前の内容は 'tougouban-mark-prev:<key>' に1世代だけ残す。
//  GET  /api/marks?key=K    … { marks: [...], updatedAt }
//  POST /api/marks/set      … body: { key, marks: [{i,s,e,c,t}, ...] }（marks が空ならマーカーを削除）

const KV_KEY = 'tougouban-text-overrides';
const BACKUP_PREFIX = 'tougouban-text-overrides-backup-';
const MAX_BACKUPS = 30;
const MAX_TEXT_LENGTH = 20000;   // 1か所あたりの文字数の上限
const MAX_ITEMS = 5000;          // 編集できる箇所数の上限
const MARK_PREFIX = 'tougouban-mark:';
const MARK_PREV_PREFIX = 'tougouban-mark-prev:';
const MAX_MARKS = 200;          // 1つの鑑定文に引けるマーカー数の上限

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

class BadRequest extends Error {}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
    },
  });
}

/* ---------- KVの読み書き ---------- */

async function readItems(env) {
  const raw = await env.TEXT_KV.get(KV_KEY);
  if (!raw) return { items: {}, raw: null };
  const obj = JSON.parse(raw);
  const items = obj && typeof obj === 'object' && obj.items && typeof obj.items === 'object' ? obj.items : {};
  return { items, raw };
}

async function writeItems(env, items, prevRaw) {
  if (Object.keys(items).length > MAX_ITEMS) {
    throw new BadRequest('編集した箇所が多すぎます（上限 ' + MAX_ITEMS + '）');
  }
  const body = JSON.stringify({ items, updatedAt: new Date().toISOString() });
  await backupBeforeWrite(env, prevRaw);
  await env.TEXT_KV.put(KV_KEY, body);
  return JSON.parse(body);
}

async function listKeys(env, prefix) {
  const out = [];
  let cursor;
  do {
    const res = await env.TEXT_KV.list({ prefix, cursor });
    out.push(...res.keys);
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

async function backupBeforeWrite(env, prevRaw) {
  if (!prevRaw) return;
  const existing = await listKeys(env, BACKUP_PREFIX);
  if (existing.length) {
    const last = await env.TEXT_KV.get(existing[existing.length - 1].name);
    if (last === prevRaw) return;   // 直近のバックアップと同じなら作らない
  }
  const name = BACKUP_PREFIX + new Date().toISOString().replace(/[:.]/g, '-');
  await env.TEXT_KV.put(name, prevRaw);
  const excess = existing.length + 1 - MAX_BACKUPS;
  for (let i = 0; i < excess; i++) {
    await env.TEXT_KV.delete(existing[i].name);
  }
}

/* ---------- 入力チェック ---------- */

async function readBody(request) {
  try {
    return await request.json();
  } catch (e) {
    throw new BadRequest('JSONとして読み取れません');
  }
}

function validateItems(items) {
  if (!items || typeof items !== 'object' || Array.isArray(items)) {
    throw new BadRequest('items は { キー: 文章 } の形で送ってください');
  }
  const keys = Object.keys(items);
  if (!keys.length) throw new BadRequest('items が空です');
  keys.forEach(function (k) {
    if (!k || k.length > 500) throw new BadRequest('キーが不正です');
    if (typeof items[k] !== 'string') throw new BadRequest('文章は文字列で送ってください');
    if (items[k].length > MAX_TEXT_LENGTH) throw new BadRequest('文章が長すぎます（上限 ' + MAX_TEXT_LENGTH + ' 文字）');
  });
}

function validateMarkKey(key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(key)) {
    throw new BadRequest('key が不正です');
  }
}

function validateMarks(marks) {
  if (!Array.isArray(marks)) throw new BadRequest('marks は配列で送ってください');
  if (marks.length > MAX_MARKS) throw new BadRequest('マーカーが多すぎます（上限 ' + MAX_MARKS + '）');
  return marks.map(function (m) {
    if (!m || typeof m !== 'object') throw new BadRequest('marks の形が不正です');
    const i = m.i, s = m.s, e = m.e;
    if (!Number.isInteger(i) || !Number.isInteger(s) || !Number.isInteger(e) || i < 0 || s < 0 || e <= s) {
      throw new BadRequest('marks の位置が不正です');
    }
    if (typeof m.c !== 'string' || m.c.length > 8) throw new BadRequest('marks の色が不正です');
    if (typeof m.t !== 'string' || m.t.length > 2000) throw new BadRequest('marks の文字が不正です');
    return { i: i, s: s, e: e, c: m.c, t: m.t };
  });
}

/* ---------- ルーティング ---------- */

async function handleApi(request, env, url) {
  if (!env.TEXT_KV) {
    return json({ error: 'KV（TEXT_KV）が接続されていません' }, 500);
  }
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;

  if (path === '/api/texts' && method === 'GET') {
    const cur = await readItems(env);
    const parsed = cur.raw ? JSON.parse(cur.raw) : {};
    return json({ items: cur.items, updatedAt: parsed.updatedAt || null });
  }

  if (path === '/api/texts/set' && method === 'POST') {
    const body = await readBody(request);
    validateItems(body.items);
    const cur = await readItems(env);
    const next = Object.assign({}, cur.items, body.items);
    const saved = await writeItems(env, next, cur.raw);
    return json({ ok: true, count: Object.keys(saved.items).length, updatedAt: saved.updatedAt });
  }

  if (path === '/api/texts/reset' && method === 'POST') {
    const body = await readBody(request);
    const cur = await readItems(env);
    let next;
    if (body.all === true) {
      next = {};
    } else if (Array.isArray(body.keys) && body.keys.length) {
      next = Object.assign({}, cur.items);
      body.keys.forEach(function (k) { delete next[k]; });
    } else {
      throw new BadRequest('keys（配列）か all:true を送ってください');
    }
    const saved = await writeItems(env, next, cur.raw);
    return json({ ok: true, count: Object.keys(saved.items).length, updatedAt: saved.updatedAt });
  }

  if (path === '/api/marks' && method === 'GET') {
    const key = url.searchParams.get('key') || '';
    validateMarkKey(key);
    const raw = await env.TEXT_KV.get(MARK_PREFIX + key);
    if (!raw) return json({ marks: [], updatedAt: null });
    const obj = JSON.parse(raw);
    return json({ marks: obj.marks || [], updatedAt: obj.updatedAt || null });
  }

  if (path === '/api/marks/set' && method === 'POST') {
    const body = await readBody(request);
    validateMarkKey(body.key);
    const marks = validateMarks(body.marks);
    const kvKey = MARK_PREFIX + body.key;
    const prev = await env.TEXT_KV.get(kvKey);
    if (prev) await env.TEXT_KV.put(MARK_PREV_PREFIX + body.key, prev);
    if (!marks.length) {
      await env.TEXT_KV.delete(kvKey);
      return json({ ok: true, count: 0 });
    }
    const updatedAt = new Date().toISOString();
    await env.TEXT_KV.put(kvKey, JSON.stringify({ marks, updatedAt }));
    return json({ ok: true, count: marks.length, updatedAt });
  }

  if (path === '/api/texts/backups' && method === 'GET') {
    const keys = await listKeys(env, BACKUP_PREFIX);
    return json({ backups: keys.map(function (k) { return k.name; }).reverse() });
  }

  if (path === '/api/texts/restore' && method === 'POST') {
    const body = await readBody(request);
    if (!body.key || String(body.key).indexOf(BACKUP_PREFIX) !== 0) {
      throw new BadRequest('バックアップのキーが不正です');
    }
    const raw = await env.TEXT_KV.get(body.key);
    if (!raw) throw new BadRequest('そのバックアップは見つかりません');
    const cur = await readItems(env);
    await backupBeforeWrite(env, cur.raw);
    await env.TEXT_KV.put(KV_KEY, raw);
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      // 念のため。通常は run_worker_first の設定で /api/ 以外はここに来ない
      return env.ASSETS.fetch(request);
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    try {
      return await handleApi(request, env, url);
    } catch (e) {
      if (e instanceof BadRequest) return json({ error: e.message }, 400);
      return json({ error: 'サーバーでエラーが起きました', detail: String(e && e.message || e) }, 500);
    }
  },
};
