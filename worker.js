// メインWorkerスクリプト
// /api/data と /api/data-light はここで処理し、それ以外は静的ファイル（public/配下）を返す。

const KV_KEY = 'friends-list';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

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

async function handleGetData(env) {
  try {
    const raw = await env.FRIEND_KV.get(KV_KEY);
    return new Response(raw || '[]', {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
    });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
}

async function handleGetDataLight(env) {
  try {
    const raw = await env.FRIEND_KV.get(KV_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    const light = Array.isArray(parsed) ? parsed.map(stripHeavyFields) : [];
    return jsonResponse(light);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
}

async function handlePostData(request, env) {
  try {
    const bodyText = await request.text();
    const parsed = JSON.parse(bodyText);
    if (!Array.isArray(parsed)) {
      throw new Error('データは配列（JSON array）である必要があります');
    }
    await env.FRIEND_KV.put(KV_KEY, JSON.stringify(parsed));
    return jsonResponse({ ok: true, count: parsed.length });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) }, 400);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === '/api/data') {
      if (request.method === 'GET') return handleGetData(env);
      if (request.method === 'POST') return handlePostData(request, env);
    }

    if (url.pathname === '/api/data-light' && request.method === 'GET') {
      return handleGetDataLight(env);
    }

    // それ以外は静的ファイル（public/index.html など）を返す
    return env.ASSETS.fetch(request);
  },
};
