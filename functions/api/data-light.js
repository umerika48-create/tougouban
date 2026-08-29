// /api/data-light
// GET のみ。/api/data と同じデータを返すが、画像など重いフィールド
// （base64画像や photo/image/avatar という名前のフィールド）を取り除いた
// 軽量版。Claudeがチャット内でこのURLをそのまま読み込んでデータ内容を
// 確認できるようにするためのエンドポイント。

const KV_KEY = 'friends-list';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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

export async function onRequestGet({ env }) {
  try {
    const raw = await env.FRIEND_KV.get(KV_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    const light = Array.isArray(parsed) ? parsed.map(stripHeavyFields) : [];
    return new Response(JSON.stringify(light, null, 2), {
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

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
