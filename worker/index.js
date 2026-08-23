export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return corsJson({
        ok: true,
        service: "rbg-tt-api",
        routes: ["/health", "/debug-env", "/github-whoami", "/github-auth-test", "/data", "/save-match", "/save-db"]
      }, env);
    }

    if (request.method === "OPTIONS") {
      return corsResponse(null, 204, env);
    }

    try {
      if (url.pathname === "/health") {
        return corsJson({ ok: true, service: "rbg-tt-api" }, env);
      }

      if (url.pathname === "/debug-env") {
        const owner = env.GH_OWNER || "Harley-RBG";
        const repo = env.GH_REPO || "Tournie-Tracker";
        const file = env.GH_FILE || "data/db.json";
        const branch = env.GH_BRANCH || "main";

        return corsJson({
          ok: true,
          has_gh_token: Boolean(env.GH_TOKEN),
          gh_token_length: env.GH_TOKEN ? env.GH_TOKEN.length : 0,
          gh_token_prefix: env.GH_TOKEN ? env.GH_TOKEN.slice(0, 10) : null,
          gh_owner: owner,
          gh_repo: repo,
          gh_branch: branch,
          gh_file: file,
          repo_test_url: `https://api.github.com/repos/${owner}/${repo}`,
          file_test_url: `https://api.github.com/repos/${owner}/${repo}/contents/${file}?ref=${branch}`
        }, env);
      }
      if (url.pathname === "/github-auth-test") {
        const owner = env.GH_OWNER || "Harley-RBG";
        const repo = env.GH_REPO || "Tournie-Tracker";
        const testUrl = `https://api.github.com/repos/${owner}/${repo}`;

        const res = await fetch(testUrl, {
          method: "GET",
          headers: githubHeaders(env)
        });

        const body = await res.text();

        return corsJson({
          ok: res.ok,
          status: res.status,
          response: safeJson(body)
        }, env, res.ok ? 200 : res.status);
      }

      if (url.pathname === "/github-whoami") {
        const res = await fetch("https://api.github.com/user", {
          method: "GET",
          headers: githubHeaders(env)
        });

        const body = await res.text();

        return corsJson({
          ok: res.ok,
          status: res.status,
          response: safeJson(body)
        }, env, res.ok ? 200 : res.status);
      }

      if (url.pathname === "/data" && request.method === "GET") {
        const db = await getDb(env);
        return new Response(JSON.stringify(db.data, null, 2), {
          status: 200,
          headers: {
            ...corsHeaders(env),
            "Content-Type": "application/json",
            "X-DB-SHA": db.sha
          }
        });
      }

      if (url.pathname === "/save-match" && request.method === "POST") {
        const payload = await request.json();

        const validation = validateMatchPayload(payload);
        if (!validation.ok) {
          return corsJson({ ok: false, error: validation.error }, env, 400);
        }

        const result = await appendMatch(env, payload);
        return corsJson({ ok: true, result }, env);
      }

      if (url.pathname === "/save-db" && request.method === "POST") {
        const payload = await request.json();
        if (!payload || typeof payload !== "object" || !payload.data) return corsJson({ ok:false, error:"Missing data object.", code:"INVALID_PAYLOAD" }, env, 400);
        const current = await getDb(env);
        const requestId = normaliseRequestId(payload.requestId);
        if (requestId) {
          const existing = findRequestMatch(current.data, requestId);
          if (existing) {
            const candidate = findRequestMatch(payload.data, requestId);
            if (candidate && matchIdentity(candidate) !== matchIdentity(existing)) return corsJson({ ok:false, error:"The requestId already belongs to a different match.", code:"IDEMPOTENCY_CONFLICT" }, env, 409);
            return corsJson({ ok:true, duplicate:true, request_id:requestId, match_id:existing.id||requestId, commit:null, db_sha:current.sha }, env);
          }
        }
        if (!payload.baseSha || typeof payload.baseSha !== "string") return corsJson({ ok:false, error:"Missing baseSha. Refresh the app and try saving again.", code:"MISSING_SHA", db_sha:current.sha }, env, 409);
        if (payload.baseSha !== current.sha) return corsJson({ ok:false, error:"Data is stale. Refresh before saving to avoid overwriting newer changes.", code:"STALE_DATA", db_sha:current.sha }, env, 409);
        const db = normaliseDb(payload.data);
        if (requestId && !findRequestMatch(db, requestId)) return corsJson({ ok:false, error:"requestId does not match a submitted match record.", code:"REQUEST_MATCH_MISSING" }, env, 400);
        try {
          const result = await putDb(env, db, current.sha, payload.message || "Update RBG-TT data");
          return corsJson({ ok:true, duplicate:false, request_id:requestId, commit:result.commit?.sha||null, db_sha:result.content?.sha||null }, env);
        } catch (err) {
          if (err?.status === 409) {
            const latest = await getDb(env), existing = requestId ? findRequestMatch(latest.data, requestId) : null;
            if (existing) return corsJson({ ok:true, duplicate:true, request_id:requestId, match_id:existing.id||requestId, commit:null, db_sha:latest.sha }, env);
            return corsJson({ ok:false, error:"Data changed while saving. Reload and retry to preserve newer results.", code:"CONCURRENT_WRITE", db_sha:latest.sha }, env, 409);
          }
          throw err;
        }
      }

      return corsJson({ ok: false, error: "Not found" }, env, 404);
    } catch (err) {
      const status = Number.isInteger(err?.status) && err.status >= 400 && err.status <= 599 ? err.status : 500;
      return corsJson({ ok:false, error:err.message || String(err), code:err.code || "WORKER_ERROR" }, env, status);
    }
  }
};

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "X-DB-SHA",
    "Access-Control-Max-Age": "86400"
  };
}

function corsResponse(body, status, env) {
  return new Response(body, {
    status,
    headers: corsHeaders(env)
  });
}

function corsJson(data, env, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...corsHeaders(env),
      "Content-Type": "application/json"
    }
  });
}

function githubHeaders(env) {
  return {
    "Authorization": `Bearer ${env.GH_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "rbg-tt-cloudflare-worker"
  };
}

function githubFileUrl(env) {
  const owner = env.GH_OWNER || "Harley-RBG";
  const repo = env.GH_REPO || "Tournie-Tracker";
  const file = env.GH_FILE || "data/db.json";
  return `https://api.github.com/repos/${owner}/${repo}/contents/${file}`;
}
function githubBlobUrl(env, sha) {
  const owner = env.GH_OWNER || "Harley-RBG";
  const repo = env.GH_REPO || "Tournie-Tracker";
  return `https://api.github.com/repos/${owner}/${repo}/git/blobs/${sha}`;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normaliseDb(data) {
  const db = data && typeof data === "object" ? data : {};

  db.players ??= [];
  db.matches ??= [];
  db.sessions ??= [];
  db.points ??= [];
  db.tournaments ??= [];
  db.rankings ??= { singles: [], doubles: [] };
  db.rankings.singles ??= [];
  db.rankings.doubles ??= [];
  db.player_stats ??= [];
  db.settings ??= { admins: [] };
  db.settings.admins ??= [];

  return db;
}

async function getDb(env) {
  const branch = env.GH_BRANCH || "main";

  const res = await fetch(`${githubFileUrl(env)}?ref=${branch}`, {
    method: "GET",
    headers: githubHeaders(env)
  });

  if (!res.ok) {
    throw new Error(`GitHub read failed: ${res.status} ${await res.text()}`);
  }

  const file = await res.json();
  const decodeContent = (content) => atob(String(content || "").replace(/\n/g, ""));
  let jsonText = "";
  let data = null;
  let parseErr = null;

  // Prefer content returned by Contents API when it is complete.
  if (file.encoding === "base64" && typeof file.content === "string" && file.content.length) {
    try {
      jsonText = decodeContent(file.content);
      data = JSON.parse(jsonText);
    } catch (err) {
      parseErr = err;
    }
  }

  // Fallback for large files where Contents API payload can be partial.
  if (!data) {
    const blobRes = await fetch(githubBlobUrl(env, file.sha), {
      method: "GET",
      headers: githubHeaders(env)
    });
    if (!blobRes.ok) {
      const blobText = await blobRes.text();
      throw new Error(
        `GitHub blob read failed: ${blobRes.status} ${blobText}${parseErr ? ` (contents parse error: ${parseErr.message || String(parseErr)})` : ""}`
      );
    }
    const blob = await blobRes.json();
    if (!blob || blob.encoding !== "base64" || typeof blob.content !== "string") {
      throw new Error("GitHub blob read returned unexpected payload.");
    }
    jsonText = decodeContent(blob.content);
    data = JSON.parse(jsonText);
  }

  return {
    sha: file.sha,
    data
  };
}

async function putDb(env, db, sha, message) {
  const json = JSON.stringify(db, null, 2), encoded = btoa(unescape(encodeURIComponent(json)));
  const res = await fetch(githubFileUrl(env), { method:"PUT", headers:githubHeaders(env), body:JSON.stringify({ message, content:encoded, sha, branch:env.GH_BRANCH || "main" }) });
  if (res.ok) return await res.json();
  const text = await res.text(), error = new Error(`GitHub write failed: ${res.status} ${text}`);
  error.status = res.status; throw error;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normaliseRequestId(value){if(typeof value!=="string")return null;const id=value.trim();return id&&id.length<=128&&/^[a-zA-Z0-9:_|.-]+$/.test(id)?id:null;}
function findRequestMatch(data,id){return id&&Array.isArray(data?.matches)?data.matches.find(m=>m&&(m.submission_id===id||m.id===id))||null:null;}
function matchIdentity(m){return JSON.stringify({type:m.type||null,mode:m.mode||null,player_a:m.player_a||null,player_b:m.player_b||null,player_c:m.player_c||null,player_d:m.player_d||null,score_a:Number(m.score_a),score_b:Number(m.score_b),session_id:m.session_id||null,game_number:m.game_number??null});}

function validateMatchPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Invalid JSON payload." };
  }

  if (!payload.match || typeof payload.match !== "object") {
    return { ok: false, error: "Missing match object." };
  }

  const match = payload.match;

  if (!match.player_a || !match.player_b) {
    return { ok: false, error: "Match requires player_a and player_b." };
  }

  if (
    typeof match.score_a !== "number" ||
    typeof match.score_b !== "number"
  ) {
    return { ok: false, error: "Match requires numeric score_a and score_b." };
  }

  if (!match.winner) {
    return { ok: false, error: "Match requires winner." };
  }

  return { ok: true };
}

async function appendMatch(env, payload) {
  const current = await getDb(env);
  const db = current.data;

  if (!Array.isArray(db.matches)) db.matches = [];
  if (!Array.isArray(db.points)) db.points = [];

  const now = new Date().toISOString();

  const match = {
    id: payload.match.id || crypto.randomUUID(),
    ...payload.match,
    created_at: payload.match.created_at || now,
    saved_via: "cloudflare-worker"
  };

  db.matches.push(match);

  if (Array.isArray(payload.points)) {
    for (const point of payload.points) {
      db.points.push({
        id: point.id || crypto.randomUUID(),
        match_id: match.id,
        ...point,
        created_at: point.created_at || now
      });
    }
  }

  if (Array.isArray(db.players)) {
    const playerIds = [
      match.player_a,
      match.player_b,
      match.player_c,
      match.player_d
    ].filter(Boolean);

    for (const player of db.players) {
      if (playerIds.includes(player.id)) {
        player.games_played = Number(player.games_played || 0) + 1;
      }
    }
  }

  const write = await putDb(
    env,
    db,
    current.sha,
    `Record match ${match.id}`
  );

  return {
    match_id: match.id,
    commit: write.commit?.sha || null
  };
}