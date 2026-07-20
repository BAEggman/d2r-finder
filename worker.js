/**
 * D2R 트레더리 파인더 — 시세 프록시 + 스크린샷 인식 (Cloudflare Worker)
 *
 * 두 가지 일을 합니다.
 *  1) GET  /api/diablo2resurrected/...  → traderie.com 시세 API 중계 (CORS 우회)
 *  2) POST /ai/identify                 → 스크린샷을 Gemini에 보내 아이템 이름 식별
 *
 * Gemini API 키는 코드에 넣지 말고 Cloudflare 시크릿으로 등록하세요.
 *   Workers & Pages → d2r-proxy → Settings → Variables and Secrets
 *   이름: GEMINI_API_KEY   (Secret 유형)
 * 키 발급: https://aistudio.google.com/apikey
 *
 * 선택 설정 (Variables, 없으면 기본값 사용)
 *   GEMINI_MODEL — 사용할 모델 이름. 미지정 시 아래 MODELS 순서로 시도합니다.
 *
 * 주의: 트레더리의 비공식 API를 사용합니다. 사이트 개편/차단 시 예고 없이
 * 동작이 멈출 수 있으며, 과도한 호출은 삼가세요 (기본 3분 캐시 적용).
 */

// 본인 GitHub Pages 주소로 좁혀두면 남이 내 프록시를 못 씁니다.
// 예: "https://myname.github.io"  ("*" 는 모두 허용)
const ALLOWED_ORIGIN = "https://baeggman.github.io";

// 트레더리 API 중 이 경로 아래만 통과시킵니다 (GET 전용).
const ALLOWED_PREFIX = "/api/diablo2resurrected/";

// 같은 요청 결과를 재사용하는 시간(초). 트레더리 부하를 줄여줍니다.
const CACHE_SECONDS = 180;

const UPSTREAM = "https://traderie.com";

// Gemini 무료 티어에서 쓸 수 있는 모델을 앞에서부터 시도합니다.
// 앞 모델이 없으면 자동으로 다음 것으로 넘어갑니다.
const MODELS = ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash"];

// 업로드 이미지 상한 (base64 기준 6MB → 원본 약 4.5MB)
const MAX_IMAGE_CHARS = 6 * 1024 * 1024;

const CORS = {
  "access-control-allow-origin": ALLOWED_ORIGIN,
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "accept, content-type",
  "access-control-max-age": "86400",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS 사전 요청
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // 루트: 상태 안내
    if (url.pathname === "/" || url.pathname === "") {
      return withCors(json({
        ok: true,
        service: "d2r-traderie-proxy",
        ai: Boolean(env && env.GEMINI_API_KEY),
        usage: "GET " + ALLOWED_PREFIX + "listings?item=<id>&selling=true&auction=false&page=0",
      }));
    }

    // ── 스크린샷 인식 ─────────────────────────────────────────
    if (url.pathname === "/ai/identify") {
      if (request.method !== "POST") {
        return withCors(json({ error: "POST only" }, 405));
      }
      if (!originAllowed(request)) {
        return withCors(json({ error: "origin not allowed" }, 403));
      }
      return withCors(await identify(request, env));
    }

    if (request.method !== "GET") {
      return withCors(json({ error: "GET only" }, 405));
    }
    if (!url.pathname.startsWith(ALLOWED_PREFIX)) {
      return withCors(json({ error: "path not allowed", allowed: ALLOWED_PREFIX }, 404));
    }

    const upstreamUrl = UPSTREAM + url.pathname + url.search;

    // 엣지 캐시 확인
    const cache = caches.default;
    const cacheKey = new Request(upstreamUrl, { method: "GET" });
    let cached = await cache.match(cacheKey);
    if (cached) {
      return withCors(new Response(cached.body, cached), "HIT");
    }

    // 트레더리로 전달 (브라우저와 비슷한 헤더, 쿠키 없음)
    let upstream;
    try {
      upstream = await fetch(upstreamUrl, {
        headers: {
          "accept": "application/json, text/plain, */*",
          "accept-language": "en-US,en;q=0.9,ko;q=0.8",
          "referer": "https://traderie.com/diablo2resurrected",
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        },
        redirect: "follow",
      });
    } catch (e) {
      return withCors(json({ error: "upstream fetch failed", detail: String(e) }, 502));
    }

    // 성공한 JSON 응답만 캐시
    const res = new Response(upstream.body, upstream);
    res.headers.delete("set-cookie");
    if (upstream.ok) {
      res.headers.set("cache-control", "public, max-age=" + CACHE_SECONDS);
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
    } else {
      res.headers.set("cache-control", "no-store");
    }
    return withCors(res, "MISS");
  },
};

/* ── Gemini 아이템 식별 ─────────────────────────────────────── */

const PROMPT = [
  "You are looking at a screenshot from the game Diablo II: Resurrected.",
  "The game client may be in Korean or English.",
  "",
  "Identify the single item shown (usually an item tooltip / description box).",
  "Return the item's OFFICIAL ENGLISH name exactly as it appears in the game.",
  "",
  "Rules:",
  "- Unique or set item: return its proper name (Korean 화관 → \"Harlequin Crest\").",
  "- Runeword: return the runeword name (수수께끼 → \"Enigma\").",
  "- Rune: return the rune name plus \" Rune\" (예: \"Ber Rune\").",
  "- Plain, magic or rare item with no proper name: return its base type (\"Archon Plate\").",
  "- If the picture is blurry or ambiguous, list up to 3 plausible candidates, best first.",
  "- Never invent an item that does not exist in Diablo II: Resurrected.",
  "",
  "Also transcribe every readable line of text in the image into the `text` field,",
  "one line per line, keeping the original language.",
].join("\n");

const SCHEMA = {
  type: "OBJECT",
  properties: {
    names: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          en: { type: "STRING", description: "Official English item name" },
          confidence: { type: "NUMBER", description: "0 to 1" },
        },
        required: ["en", "confidence"],
      },
    },
    text: { type: "STRING", description: "All readable text in the image" },
  },
  required: ["names", "text"],
};

async function identify(request, env) {
  const key = env && env.GEMINI_API_KEY;
  if (!key) {
    return json({
      error: "no_api_key",
      message: "Gemini API 키가 워커에 등록되어 있지 않습니다. Cloudflare 대시보드에서 GEMINI_API_KEY 시크릿을 추가해 주세요.",
    }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "bad_request", message: "요청 본문을 읽지 못했습니다." }, 400);
  }

  const data = body && body.data;
  const mime = (body && body.mime) || "image/jpeg";
  if (typeof data !== "string" || data.length < 32) {
    return json({ error: "bad_request", message: "이미지 데이터가 없습니다." }, 400);
  }
  if (data.length > MAX_IMAGE_CHARS) {
    return json({ error: "too_large", message: "이미지가 너무 큽니다. 더 작게 잘라서 올려주세요." }, 413);
  }
  if (!/^image\/(png|jpeg|webp|gif)$/.test(mime)) {
    return json({ error: "bad_request", message: "지원하지 않는 이미지 형식입니다." }, 400);
  }

  const payload = {
    contents: [{
      role: "user",
      parts: [
        { text: PROMPT },
        { inline_data: { mime_type: mime, data } },
      ],
    }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: SCHEMA,
    },
  };

  const models = [];
  if (env.GEMINI_MODEL) models.push(env.GEMINI_MODEL);
  for (const m of MODELS) if (!models.includes(m)) models.push(m);

  let lastStatus = 0, lastDetail = "";
  for (const model of models) {
    let r;
    try {
      r = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" +
          encodeURIComponent(model) + ":generateContent",
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify(payload),
        }
      );
    } catch (e) {
      lastStatus = 502; lastDetail = String(e);
      continue;
    }

    if (r.ok) {
      const out = await r.json().catch(() => null);
      const raw = out && out.candidates && out.candidates[0] &&
        out.candidates[0].content && out.candidates[0].content.parts &&
        out.candidates[0].content.parts[0] && out.candidates[0].content.parts[0].text;
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { /* 아래에서 처리 */ }
      if (!parsed) {
        return json({ error: "bad_model_output", message: "인식 결과를 해석하지 못했습니다." }, 502);
      }
      const names = Array.isArray(parsed.names)
        ? parsed.names.filter(n => n && typeof n.en === "string" && n.en.trim()).slice(0, 3)
        : [];
      return json({
        ok: true,
        model,
        names: names.map(n => ({ en: n.en.trim(), confidence: Number(n.confidence) || 0 })),
        text: typeof parsed.text === "string" ? parsed.text : "",
      });
    }

    lastStatus = r.status;
    lastDetail = (await r.text().catch(() => "")).slice(0, 300);

    // 404/400 = 그 모델이 없음 → 다음 후보로. 그 외에는 즉시 중단.
    if (r.status !== 404 && r.status !== 400) break;
  }

  if (lastStatus === 429) {
    return json({
      error: "rate_limited",
      message: "Gemini 무료 할당량을 다 썼습니다. 잠시 후(또는 내일) 다시 시도해 주세요.",
    }, 429);
  }
  if (lastStatus === 401 || lastStatus === 403) {
    return json({
      error: "bad_api_key",
      message: "Gemini API 키가 거부됐습니다. 키가 올바른지 확인해 주세요.",
    }, 502);
  }
  return json({
    error: "upstream_error",
    message: "인식 서버에 문제가 있습니다. 잠시 후 다시 시도해 주세요.",
    status: lastStatus,
    detail: lastDetail,
  }, 502);
}

/* ── helpers ────────────────────────────────────────────────── */

function originAllowed(request) {
  if (ALLOWED_ORIGIN === "*") return true;
  const origin = request.headers.get("origin");
  if (origin) return origin === ALLOWED_ORIGIN;
  // 브라우저가 Origin을 안 붙이는 경우는 Referer로 한 번 더 확인
  const ref = request.headers.get("referer") || "";
  return ref.startsWith(ALLOWED_ORIGIN + "/") || ref === ALLOWED_ORIGIN;
}

function withCors(res, cacheState) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  if (cacheState) out.headers.set("x-proxy-cache", cacheState);
  return out;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
