// /api/data
// GET  : KVに保存されている友達データ（配列）をJSONで返す
// POST : リクエストボディ（JSON配列）でKVを丸ごと上書き保存する
//
// 認証なし。誰でも読み書きできる共有データベースとして動作する。
// Cloudflare Pages の「Settings > Functions > KV namespace bindings」で
// 変数名 FRIEND_KV としてKVネームスペースをバインドしておくこと。

const KV_KEY = 'friends-list';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestGet({ env }) {
  try {
    const raw = await env.FRIEND_KV.get(KV_KEY);
    return new Response(raw || '[]', {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
    });
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const bodyText = await request.text();
    const parsed = JSON.parse(bodyText);
    if (!Array.isArray(parsed)) {
      throw new Error('データは配列（JSON array）である必要があります');
    }
    await env.FRIEND_KV.put(KV_KEY, JSON.stringify(parsed));
    return new Response(JSON.stringify({ ok: true, count: parsed.length }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 400,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
