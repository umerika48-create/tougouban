// 友達データ帳 Worker
// - 静的ファイル（public/）の配信
// - 共有データベース（Cloudflare KV）の API
//
// 【データの考え方】
//  KVの 'friends-list' に、友達データ全体（JSON配列）を1つのキーで保存している。
//
// 【事故防止の仕組み】
//  1. 空配列での上書きは常に拒否する
//  2. 件数が半分未満に減る上書きは拒否する（?force=1 で解除）
//  3. 書き込みの直前に、いまの内容を自動でバックアップする
//     - friends-list-backup-<日時> … 直近30件
//     - friends-list-daily-<日付>  … 1日1回（その日の最初の書き込み前の状態）、直近14日
//  4. 追加・更新・削除は「1人単位の操作」（/api/upsert, /api/delete）で行い、
//     古い全体データで丸ごと上書きしてしまう事故が起きないようにする
//
// 認証なし。誰でも読み書きできる共有データベース（本人了承済み）。
//
// 【API】
//  GET  /api/data                … 全データ（JSON配列）
//  GET  /api/data-light          … 画像など重い項目を除いた軽量版（Claude確認用）
//  GET  /api/check/<任意の文字列> … data-lightと同じ。URLを変えて使うためのもの
//  POST /api/upsert              … 追加・更新。body: 配列 または {items:[...], force?:true}
//                                   idが一致する人、なければ名前が一致する人を更新、それ以外は新規追加
//  POST /api/delete              … 削除。body: {ids:[...], names:[...], force?:true}
//  POST /api/data                … 全データの置き換え（通常は使わない。?force=1 で件数減を許可）
//  GET  /api/backups             … バックアップ一覧
//  POST /api/restore             … バックアップから復元。body: {key:"..."}

const KV_KEY = 'friends-list';
const BACKUP_PREFIX = 'friends-list-backup-';
const DAILY_PREFIX = 'friends-list-daily-';
const MAX_BACKUPS = 30;
const MAX_DAILY = 14;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

class GuardError extends Error {}   // 安全装置による拒否（409）
class BadRequest extends Error {}   // 入力の不備（400）

function respond(bodyText, status = 200) {
  return new Response(bodyText, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
    },
  });
}
function json(data, status = 200) {
  return respond(JSON.stringify(data), status);
}

/* ---------- KVの読み書き ---------- */

async function readRaw(env) {
  return await env.FRIEND_KV.get(KV_KEY);
}

function parseList(raw) {
  if (!raw) return [];
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error('保存されているデータが配列ではありません');
  return arr;
}

function validateList(list) {
  if (!Array.isArray(list)) {
    throw new BadRequest('データは配列（JSON array）である必要があります');
  }
  for (const f of list) {
    if (!f || typeof f !== 'object' || typeof f.name !== 'string' || !f.name.trim()) {
      throw new BadRequest('name（名前）のない項目が含まれています');
    }
  }
}

async function listKeys(env, prefix) {
  const out = [];
  let cursor;
  do {
    const res = await env.FRIEND_KV.list({ prefix, cursor });
    out.push(...res.keys);
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
  // キーに日時・日付を含めているので、名前順＝古い順
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

async function prune(env, prefix, max) {
  const keys = await listKeys(env, prefix);
  const excess = keys.length - max;
  for (let i = 0; i < excess; i++) {
    await env.FRIEND_KV.delete(keys[i].name);
  }
}

function jstDate(date) {
  return new Date(date.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

async function backupBeforeWrite(env, currentRaw, currentCount, newRaw) {
  if (!currentRaw || currentRaw.trim() === '[]' || currentRaw === newRaw) return;
  const now = new Date();
  const iso = now.toISOString();
  const meta = { count: currentCount, at: iso };

  // 直近のバックアップと同じ内容なら、新しく作らない
  const existing = await listKeys(env, BACKUP_PREFIX);
  let same = false;
  if (existing.length) {
    const last = await env.FRIEND_KV.get(existing[existing.length - 1].name);
    same = last === currentRaw;
  }
  if (!same) {
    await env.FRIEND_KV.put(BACKUP_PREFIX + iso, currentRaw, { metadata: meta });
    await prune(env, BACKUP_PREFIX, MAX_BACKUPS);
  }

  // 1日1回、その日の最初の書き込み前の状態を残す
  const dailyKey = DAILY_PREFIX + jstDate(now);
  if (!(await env.FRIEND_KV.get(dailyKey))) {
    await env.FRIEND_KV.put(dailyKey, currentRaw, { metadata: meta });
    await prune(env, DAILY_PREFIX, MAX_DAILY);
  }
}

async function hasAnyBackup(env) {
  const a = await env.FRIEND_KV.list({ prefix: BACKUP_PREFIX, limit: 1 });
  if (a.keys.length) return true;
  const b = await env.FRIEND_KV.list({ prefix: DAILY_PREFIX, limit: 1 });
  return b.keys.length > 0;
}

// 安全装置つきの書き込み。KVに書き込む処理は必ずここを通す。
async function writeList(env, newList, { force = false } = {}) {
  validateList(newList);
  if (newList.length === 0) {
    throw new GuardError('空のデータでの上書きは拒否しました');
  }
  const currentRaw = await readRaw(env);
  let currentCount = 0;
  try {
    currentCount = parseList(currentRaw).length;
  } catch (e) {
    currentCount = 0; // 壊れたデータでも、バックアップだけは残す
  }
  if (!force && currentCount >= 10 && newList.length < currentCount * 0.5) {
    throw new GuardError(
      `件数が大きく減るため拒否しました（${currentCount}件 → ${newList.length}件）。意図した操作なら force を指定してください`
    );
  }
  const newRaw = JSON.stringify(newList);
  await backupBeforeWrite(env, currentRaw, currentCount, newRaw);
  await env.FRIEND_KV.put(KV_KEY, newRaw);
  return newList;
}

/* ---------- 1人単位の操作 ---------- */

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function mergeItem(incoming, existing) {
  const base = existing ? { ...existing, ...incoming } : { ...incoming };
  base.name = String(base.name).trim();
  base.id = existing ? existing.id : (incoming.id || newId());
  if (base.visible === undefined) base.visible = true;
  if (!existing) {
    if (base.addedAt === undefined) base.addedAt = Date.now();
    if (base.date === undefined) base.date = '';
    if (base.time === undefined) base.time = '';
    if (base.place === undefined) base.place = '';
    if (base.memo === undefined) base.memo = '';
    if (base.category === undefined) base.category = '未分類';
    if (base.timeUnknown === undefined) base.timeUnknown = !base.time;
  }
  return base;
}

async function upsert(env, payload) {
  let items = Array.isArray(payload) ? payload : payload && payload.items;
  const force = !Array.isArray(payload) && !!(payload && payload.force);
  if (items && !Array.isArray(items)) items = [items];
  validateList(items);
  if (items.length === 0) throw new BadRequest('追加・更新する人がいません');

  const list = parseList(await readRaw(env));

  // 全データが空なのにバックアップがある＝消えてしまった状態。
  // 1人だけ追加して「消えた状態」を確定させてしまわないよう止める。
  if (list.length === 0 && !force && (await hasAnyBackup(env))) {
    throw new GuardError(
      'サーバーのデータが空です。バックアップからの復旧が必要です（/api/backups を確認してください）'
    );
  }

  let added = 0;
  let updated = 0;
  for (const f of items) {
    const name = String(f.name).trim();
    let idx = f.id ? list.findIndex((x) => x.id === f.id) : -1;
    if (idx < 0) idx = list.findIndex((x) => x.name === name);
    if (idx >= 0) {
      list[idx] = mergeItem(f, list[idx]);
      updated++;
    } else {
      list.push(mergeItem(f, null));
      added++;
    }
  }
  await writeList(env, list);
  return { data: list, added, updated };
}

async function deleteItems(env, payload) {
  const ids = Array.isArray(payload && payload.ids) ? payload.ids : [];
  const names = Array.isArray(payload && payload.names) ? payload.names : [];
  const force = !!(payload && payload.force);
  if (!ids.length && !names.length) throw new BadRequest('削除する人（ids または names）が指定されていません');

  const list = parseList(await readRaw(env));
  const next = list.filter((f) => !ids.includes(f.id) && !names.includes(f.name));
  const removed = list.length - next.length;
  if (removed === 0) return { data: list, removed: 0 };
  await writeList(env, next, { force });
  return { data: next, removed };
}

/* ---------- バックアップ ---------- */

async function listBackups(env) {
  const daily = await listKeys(env, DAILY_PREFIX);
  const rolling = await listKeys(env, BACKUP_PREFIX);
  const toRow = (kind) => (k) => ({
    key: k.name,
    kind,
    count: k.metadata && k.metadata.count,
    at: k.metadata && k.metadata.at,
  });
  return [...rolling.map(toRow('auto')), ...daily.map(toRow('daily'))]
    .sort((a, b) => (a.key < b.key ? 1 : -1));
}

async function restore(env, key) {
  if (typeof key !== 'string' || !(key.startsWith(BACKUP_PREFIX) || key.startsWith(DAILY_PREFIX))) {
    throw new BadRequest('バックアップのキーが正しくありません');
  }
  const raw = await env.FRIEND_KV.get(key);
  if (!raw) throw new BadRequest('そのバックアップは見つかりません');
  const arr = parseList(raw);
  // 復元前のいまの内容も、writeListがバックアップしてから上書きする
  await writeList(env, arr, { force: true });
  return arr;
}

/* ---------- 軽量版 ---------- */

function stripHeavyFields(obj) {
  const copy = { ...obj };
  Object.keys(copy).forEach((key) => {
    const val = copy[key];
    if (typeof val === 'string' && val.startsWith('data:image')) {
      delete copy[key];
      return;
    }
    if (/photo|image|avatar|picture/i.test(key)) {
      delete copy[key];
    }
  });
  return copy;
}

/* ---------- ルーティング ---------- */

async function readBody(request) {
  const text = await request.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new BadRequest('JSONの形式が正しくありません');
  }
}

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/data' && method === 'GET') {
    return respond((await readRaw(env)) || '[]');
  }
  if ((path === '/api/data-light' || path.startsWith('/api/check/')) && method === 'GET') {
    const list = parseList(await readRaw(env));
    return respond(JSON.stringify(list.map(stripHeavyFields), null, 2));
  }
  if (path === '/api/data' && method === 'POST') {
    const list = await readBody(request);
    const force = url.searchParams.get('force') === '1';
    const data = await writeList(env, list, { force });
    return json({ ok: true, count: data.length });
  }
  if (path === '/api/upsert' && method === 'POST') {
    const r = await upsert(env, await readBody(request));
    return json({ ok: true, count: r.data.length, added: r.added, updated: r.updated, data: r.data });
  }
  if (path === '/api/delete' && method === 'POST') {
    const r = await deleteItems(env, await readBody(request));
    return json({ ok: true, count: r.data.length, removed: r.removed, data: r.data });
  }
  if (path === '/api/backups' && method === 'GET') {
    return json({ ok: true, backups: await listBackups(env) });
  }
  if (path === '/api/restore' && method === 'POST') {
    const body = await readBody(request);
    const data = await restore(env, body && body.key);
    return json({ ok: true, count: data.length, data });
  }
  return json({ ok: false, error: 'このURLは存在しません' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        if (err instanceof GuardError) return json({ ok: false, error: err.message, guard: true }, 409);
        if (err instanceof BadRequest) return json({ ok: false, error: err.message }, 400);
        return json({ ok: false, error: String(err && err.message ? err.message : err) }, 500);
      }
    }

    // それ以外は静的ファイル（public/ 配下）を返す
    return env.ASSETS.fetch(request);
  },
};
