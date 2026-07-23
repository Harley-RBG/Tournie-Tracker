export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return corsResponse(null, 204, env);
    }

    try {
      if (url.pathname === "/health") {
        return corsJson({ ok: true, service: "rbg-tt-api" }, env);
      }

      if (url.pathname === "/debug-env") {
        const owner = env.GH_OWNER;
        const repo = env.GH_REPO;
        const file = env.GH_FILE || "db.json";
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
        const testUrl = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}`;

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

      if (url.pathname === "/data" && request.method === "GET") {
        const db = await getDb(env);
        return corsJson(db.data, env);
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

      return corsJson({ ok: false, error: "Not found" }, env, 404);
    } catch (err) {
      return corsJson(
        {
          ok: false,
          error: err.message || String(err)
        },
        env,
        500
      );
    }
  }
};

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
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
  const owner = env.GH_OWNER;
  const repo = env.GH_REPO;
  const file = env.GH_FILE || "db.json";

  return `https://api.github.com/repos/${owner}/${repo}/contents/${file}`;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
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
  const jsonText = atob(file.content.replace(/\n/g, ""));
  const data = JSON.parse(jsonText);

  return {
    sha: file.sha,
    data
  };
}

async function putDb(env, db, sha, message) {
  const json = JSON.stringify(db, null, 2);
  const encoded = btoa(unescape(encodeURIComponent(json)));

  const res = await fetch(githubFileUrl(env), {
    method: "PUT",
    headers: githubHeaders(env),
    body: JSON.stringify({
      message,
      content: encoded,
      sha,
      branch: env.GH_BRANCH || "main"
    })
  });

  if (!res.ok) {
    throw new Error(`GitHub write failed: ${res.status} ${await res.text()}`);
  }

  return await res.json();
}

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