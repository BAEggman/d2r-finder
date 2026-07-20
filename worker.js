/**
 * D2R 트레더리 파인더 — 시세 프록시 (Cloudflare Worker)
 *
 * 역할: GitHub Pages(정적 사이트)에서는 브라우저 보안 정책(CORS) 때문에
 * traderie.com API를 직접 호출할 수 없습니다. 이 Worker가 중간에서
 * 요청을 대신 전달하고, CORS 허용 헤더를 붙여 돌려줍니다.
 *
 * 배포 방법은 README.md의 "Cloudflare Worker 만들기 (5분)" 참고.
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

const CORS = {
  "access-control-allow-origin": ALLOWED_ORIGIN,
  "access-control-allow-methods": "GET, OPTIONS",
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
        usage: "GET " + ALLOWED_PREFIX + "listings?item=<id>&selling=true&auction=false&page=0",
      }));
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
