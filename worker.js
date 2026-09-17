import PROVIDER_CONFIG from "./providers.json";

const VERSION = "2.0.0";

const DEFAULTS = {
  timeoutMs: 8000,
  retries: 1,
  cacheTtl: 300,
  maxProviders: 50,
  maxResultsPerProvider: 50,
  maxTotalResults: 200
};

const ALLOWED_METHODS = new Set(["GET", "POST"]);

const PLAYBACK_TYPES = new Set([
  "hls",
  "m3u8",
  "dash",
  "mp4",
  "webm",
  "ogv",
  "webrtc",
  "rtmp",
  "direct",
  "external",
  "page",
  "platform_player",
  "source_platform_stream",
  "platform_source",
  "unknown"
]);

/* =========================================================
   PROVIDER REGISTRY
   ========================================================= */

function loadProviders() {
  if (Array.isArray(PROVIDER_CONFIG)) {
    return PROVIDER_CONFIG;
  }

  if (
    PROVIDER_CONFIG &&
    Array.isArray(PROVIDER_CONFIG.providers)
  ) {
    return PROVIDER_CONFIG.providers;
  }

  return [];
}

function getProviders() {
  return loadProviders().filter(
    provider => provider && provider.enabled !== false
  );
}

function getProvider(id) {
  return getProviders().find(
    provider => provider.id === id
  );
}

/* =========================================================
   MAIN ENTRY
   ========================================================= */

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === "OPTIONS") {
        return corsResponse(
          new Response(null, { status: 204 })
        );
      }

      const url = new URL(request.url);

      if (url.pathname === "/") {
        return json({
          ok: true,
          service: "Open Source Provider",
          poweredBy: "Prophecy",
          version: VERSION,
          providers: getProviders().length
        });
      }

      if (url.pathname === "/health") {
        return handleHealth();
      }

      if (url.pathname === "/providers") {
        return handleProviders(url);
      }

      if (url.pathname === "/search") {
        return handleSearch(request, env, ctx);
      }

      if (url.pathname === "/resolve") {
        return handleResolve(request, env, ctx);
      }

      return errorResponse(
        "NOT_FOUND",
        "Route not found",
        404
      );

    } catch (error) {
      console.error("Worker error:", error);

      return errorResponse(
        "INTERNAL_ERROR",
        "Internal server error",
        500
      );
    }
  }
};

/* =========================================================
   HEALTH
   ========================================================= */

function handleHealth() {
  return json({
    ok: true,
    status: "online",
    version: VERSION,
    providerCount: getProviders().length,
    timestamp: new Date().toISOString()
  });
}

/* =========================================================
   PROVIDER LIST
   ========================================================= */

function handleProviders(url) {
  const includeDisabled =
    url.searchParams.get("includeDisabled") === "true";

  const providers = includeDisabled
    ? loadProviders()
    : getProviders();

  return json({
    ok: true,
    count: providers.length,

    providers: providers.map(p => ({
      id: p.id,
      name: p.name,
      category: p.category || "unknown",
      enabled: p.enabled !== false,
      instanceRequired: !!p.instance_required,

      search: !!p.search?.enabled,

      resolve: !!p.resolve?.enabled,

      playback: !!p.playback?.enabled,

      playbackTypes:
        p.playback?.types || [],

      authentication:
        p.authentication?.type || "none",

      rights:
        p.rights || null
    }))
  });
}

/* =========================================================
   SEARCH
   ========================================================= */

async function handleSearch(request, env, ctx) {
  const url = new URL(request.url);

  const query =
    cleanText(url.searchParams.get("q"));

  if (!query) {
    return errorResponse(
      "INVALID_REQUEST",
      "Missing q parameter",
      400
    );
  }

  const type =
    cleanText(url.searchParams.get("type"));

  const season =
    parseNumber(url.searchParams.get("season"));

  const episode =
    parseNumber(url.searchParams.get("episode"));

  const requestedProvider =
    cleanText(url.searchParams.get("provider"));

  let providers = getProviders()
    .filter(p => p.search?.enabled !== false);

  if (requestedProvider) {
    providers = providers.filter(
      p => p.id === requestedProvider
    );
  }

  providers =
    providers.slice(0, DEFAULTS.maxProviders);

  const cacheKey = createCacheKey(
    "search",
    {
      q: query,
      type,
      season,
      episode,
      provider: requestedProvider || "all"
    }
  );

  const cached =
    await getCache(cacheKey);

  if (cached) {
    return cached;
  }

  const results = await parallelMap(
    providers,
    provider =>
      searchProvider(
        provider,
        {
          query,
          type,
          season,
          episode
        },
        env
      )
  );

  const successful = results
    .filter(x => x.ok)
    .flatMap(x => x.results);

  const failed = results
    .filter(x => !x.ok)
    .map(x => ({
      provider: x.provider,
      error: x.error
    }));

  const normalized =
    deduplicateResults(
      successful
    ).slice(
      0,
      DEFAULTS.maxTotalResults
    );

  const response = json({
    ok: true,

    query: {
      q: query,
      type: type || null,
      season: season || null,
      episode: episode || null
    },

    count: normalized.length,

    results: normalized,

    providers: {
      requested: providers.length,
      successful:
        providers.length - failed.length,
      failed
    }
  });

  ctx.waitUntil(
    putCache(
      cacheKey,
      response.clone(),
      DEFAULTS.cacheTtl
    )
  );

  return response;
}

/* =========================================================
   RESOLVE
   ========================================================= */

async function handleResolve(request, env, ctx) {
  const url = new URL(request.url);

  const providerId =
    cleanText(
      url.searchParams.get("provider")
    );

  const id =
    cleanText(
      url.searchParams.get("id")
    );

  if (!providerId || !id) {
    return errorResponse(
      "INVALID_REQUEST",
      "provider and id are required",
      400
    );
  }

  const provider =
    getProvider(providerId);

  if (!provider) {
    return errorResponse(
      "PROVIDER_NOT_FOUND",
      "Provider not found",
      404
    );
  }

  if (provider.resolve?.enabled === false) {
    return errorResponse(
      "RESOLVE_NOT_SUPPORTED",
      "This provider does not support resolve",
      400
    );
  }

  const result =
    await resolveProvider(
      provider,
      { id },
      env
    );

  if (!result.ok) {
    return errorResponse(
      result.code || "PROVIDER_ERROR",
      result.error,
      502
    );
  }

  return json({
    ok: true,
    provider: provider.id,
    result: result.result
  });
}

/* =========================================================
   PROVIDER SEARCH ENGINE
   ========================================================= */

async function searchProvider(
  provider,
  params,
  env
) {
  try {
    if (
      provider.instance_required &&
      !provider.baseUrl
    ) {
      return {
        ok: false,
        provider: provider.id,
        error: "Provider instance URL is missing"
      };
    }

    const config =
      provider.search || {};

    const method =
      normalizeMethod(
        config.method || "GET"
      );

    if (!ALLOWED_METHODS.has(method)) {
      return {
        ok: false,
        provider: provider.id,
        error: `Unsupported method: ${method}`
      };
    }

    const target =
      buildProviderRequest(
        provider,
        config,
        params,
        env
      );

    const response =
      await fetchWithRetry(
        target.url,
        {
          method,
          headers: target.headers,
          body: target.body
        },
        provider
      );

    if (!response.ok) {
      return {
        ok: false,
        provider: provider.id,
        error:
          `HTTP ${response.status}`
      };
    }

    const data =
      await parseResponse(response);

    const items =
      extractResults(
        data,
        config.resultsPath
      );

    const normalized =
      items
        .slice(
          0,
          DEFAULTS.maxResultsPerProvider
        )
        .map(item =>
          normalizeProviderResult(
            item,
            provider,
            params
          )
        )
        .filter(Boolean);

    return {
      ok: true,
      provider: provider.id,
      results: normalized
    };

  } catch (error) {
    console.error(
      `Provider ${provider.id}:`,
      error
    );

    return {
      ok: false,
      provider: provider.id,
      error: error.message
    };
  }
}

/* =========================================================
   PROVIDER RESOLVE ENGINE
   ========================================================= */

async function resolveProvider(
  provider,
  params,
  env
) {
  try {
    const config =
      provider.resolve || {};

    const method =
      normalizeMethod(
        config.method || "GET"
      );

    const target =
      buildProviderRequest(
        provider,
        config,
        params,
        env
      );

    const response =
      await fetchWithRetry(
        target.url,
        {
          method,
          headers: target.headers,
          body: target.body
        },
        provider
      );

    if (!response.ok) {
      return {
        ok: false,
        code: "PROVIDER_ERROR",
        error:
          `HTTP ${response.status}`
      };
    }

    const data =
      await parseResponse(response);

    const normalized =
      normalizeProviderResult(
        data,
        provider,
        params
      );

    return {
      ok: true,
      result: normalized
    };

  } catch (error) {
    return {
      ok: false,
      code: "PROVIDER_ERROR",
      error: error.message
    };
  }
}

/* =========================================================
   REQUEST BUILDER
   ========================================================= */

function buildProviderRequest(
  provider,
  config,
  params,
  env
) {
  const base =
    config.baseUrl ||
    provider.apiBaseUrl ||
    provider.baseUrl ||
    "";

  const apiBase =
    provider.apiBaseUrl ||
    provider.baseUrl ||
    "";

  let path =
    config.path || "";

  path =
    template(
      path,
      params,
      provider,
      env
    );

  const baseUrl =
    path.startsWith("http://") ||
    path.startsWith("https://")
      ? path
      : joinUrl(apiBase, path);

  const url =
    new URL(baseUrl);

  const query =
    config.query || {};

  for (
    const [key, value] of Object.entries(query)
  ) {
    const resolved =
      resolveTemplateValue(
        value,
        params,
        provider,
        env
      );

    if (
      resolved !== undefined &&
      resolved !== null &&
      resolved !== ""
    ) {
      url.searchParams.set(
        key,
        String(resolved)
      );
    }
  }

  const headers =
    buildAuthHeaders(
      provider,
      env
    );

  let body;

  if (
    config.body &&
    typeof config.body === "object"
  ) {
    body = JSON.stringify(
      resolveObjectTemplates(
        config.body,
        params,
        provider,
        env
      )
    );

    headers["Content-Type"] =
      "application/json";
  }

  return {
    url: url.toString(),
    headers,
    body
  };
}

/* =========================================================
   AUTH
   ========================================================= */

function buildAuthHeaders(
  provider,
  env
) {
  const headers = {
    Accept: "application/json"
  };

  const auth =
    provider.authentication || {};

  if (
    !auth.required ||
    !auth.secretName
  ) {
    return headers;
  }

  const secret =
    env[auth.secretName];

  if (!secret) {
    return headers;
  }

  switch (
    String(auth.type || "").toLowerCase()
  ) {
    case "bearer":
      headers.Authorization =
        `Bearer ${secret}`;
      break;

    case "api_key":
    case "apikey":
      headers["X-API-Key"] =
        secret;
      break;

    default:
      headers.Authorization =
        `Bearer ${secret}`;
  }

  return headers;
}

/* =========================================================
   FETCH + RETRY + TIMEOUT
   ========================================================= */

async function fetchWithRetry(
  url,
  options,
  provider
) {
  const retries =
    Number.isInteger(
      provider.retries
    )
      ? provider.retries
      : DEFAULTS.retries;

  let lastError;

  for (
    let attempt = 0;
    attempt <= retries;
    attempt++
  ) {
    try {
      return await fetchWithTimeout(
        url,
        options,
        provider.timeoutMs ||
          DEFAULTS.timeoutMs
      );
    } catch (error) {
      lastError = error;

      if (attempt < retries) {
        await sleep(
          250 * (attempt + 1)
        );
      }
    }
  }

  throw lastError ||
    new Error("Request failed");
}

async function fetchWithTimeout(
  url,
  options,
  timeoutMs
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
      timeoutMs
    );

  try {
    return await fetch(
      url,
      {
        ...options,
        redirect: "follow",
        signal: controller.signal
      }
    );
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================
   RESPONSE PARSER
   ========================================================= */

async function parseResponse(
  response
) {
  const type =
    response.headers
      .get("content-type") || "";

  if (
    type.includes("application/json") ||
    type.includes("+json")
  ) {
    return response.json();
  }

  const text =
    await response.text();

  try {
    return JSON.parse(text);
  } catch {
    return {
      text
    };
  }
}

/* =========================================================
   RESULT EXTRACTION
   ========================================================= */

function extractResults(
  data,
  resultsPath
) {
  if (!data) return [];

  if (resultsPath) {
    const value =
      getPath(
        data,
        resultsPath
      );

    if (Array.isArray(value)) {
      return value;
    }

    if (value) {
      return [value];
    }
  }

  if (Array.isArray(data)) {
    return data;
  }

  const candidates = [
    data.results,
    data.items,
    data.data,
    data.videos,
    data.entries,
    data.records,
    data.channels,
    data.shows,
    data.media
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [data];
}

/* =========================================================
   NORMALIZATION
   ========================================================= */

function normalizeProviderResult(
  item,
  provider,
  requestParams
) {
  if (!item) return null;

  const title =
    firstValue(item, [
      "title",
      "name",
      "display_name",
      "label"
    ]);

  const url =
    firstValue(item, [
      "url",
      "videoUrl",
      "video_url",
      "playbackUrl",
      "playback_url",
      "streamUrl",
      "stream_url",
      "file",
      "src",
      "source"
    ]);

  const providerItemId =
    String(
      firstValue(item, [
        "id",
        "uuid",
        "videoId",
        "video_id",
        "identifier",
        "slug"
      ]) || ""
    );

  const normalizedUrl =
    normalizePlaybackUrl(
      url
    );

  const type =
    normalizeType(
      firstValue(item, [
        "type",
        "media_type",
        "content_type"
      ]) ||
      requestParams.type
    );

  const season =
    toNumber(
      firstValue(item, [
        "season",
        "season_number",
        "seasonNumber"
      ])
    );

  const episode =
    toNumber(
      firstValue(item, [
        "episode",
        "episode_number",
        "episodeNumber",
        "episode_no"
      ])
    );

  const languages =
    normalizeArray(
      firstValue(item, [
        "language",
        "languages",
        "lang"
      ])
    );

  const subtitles =
    normalizeArray(
      firstValue(item, [
        "subtitle",
        "subtitles",
        "captions"
      ])
    );

  return {
    provider:
      provider.id,

    providerName:
      provider.name ||
      provider.id,

    providerItemId,

    title:
      title || null,

    originalTitle:
      firstValue(item, [
        "originalTitle",
        "original_title"
      ]) || null,

    type,

    year:
      toNumber(
        firstValue(item, [
          "year",
          "release_year"
        ])
      ),

    season,

    episode,

    episodeTitle:
      firstValue(item, [
        "episodeTitle",
        "episode_title"
      ]) || null,

    url:
      normalizedUrl.url,

    urlType:
      normalizedUrl.type,

    language:
      languages,

    subtitle:
      subtitles,

    duration:
      toNumber(
        firstValue(item, [
          "duration",
          "duration_seconds"
        ])
      ),

    thumbnail:
      firstValue(item, [
        "thumbnail",
        "thumbnailUrl",
        "thumbnail_url",
        "poster",
        "posterUrl",
        "poster_url"
      ]) || null,

    license:
      firstValue(item, [
        "license",
        "licence"
      ]) ||
      provider.rights?.license ||
      null,

    rights:
      provider.rights || null,

    playback:
      {
        available:
          !!normalizedUrl.url,

        type:
          normalizedUrl.type,

        direct:
          !!normalizedUrl.url
      }
  };
}

/* =========================================================
   PLAYBACK URL DETECTION
   ========================================================= */

function normalizePlaybackUrl(
  raw
) {
  if (
    typeof raw !== "string" ||
    !raw.trim()
  ) {
    return {
      url: null,
      type: "unknown"
    };
  }

  let value =
    raw.trim();

  try {
    const parsed =
      new URL(value);

    const pathname =
      parsed.pathname.toLowerCase();

    if (
      pathname.endsWith(".m3u8")
    ) {
      return {
        url: parsed.toString(),
        type: "hls"
      };
    }

    if (
      pathname.endsWith(".mpd")
    ) {
      return {
        url: parsed.toString(),
        type: "dash"
      };
    }

    if (
      pathname.endsWith(".mp4")
    ) {
      return {
        url: parsed.toString(),
        type: "mp4"
      };
    }

    if (
      pathname.endsWith(".webm")
    ) {
      return {
        url: parsed.toString(),
        type: "webm"
      };
    }

    if (
      pathname.endsWith(".ogv") ||
      pathname.endsWith(".ogg")
    ) {
      return {
        url: parsed.toString(),
        type: "ogv"
      };
    }

    return {
      url: parsed.toString(),
      type: "page"
    };

  } catch {
    return {
      url: value,
      type: "unknown"
    };
  }
}

/* =========================================================
   DEDUPLICATION
   ========================================================= */

function deduplicateResults(
  results
) {
  const map =
    new Map();

  for (const item of results) {
    const key =
      [
        normalizeTitle(item.title),
        item.type || "unknown",
        item.year || "",
        item.season || "",
        item.episode || ""
      ].join("|");

    if (!map.has(key)) {
      map.set(key, item);
    }
  }

  return [...map.values()];
}

/* =========================================================
   PARALLEL PROVIDERS
   ========================================================= */

async function parallelMap(
  items,
  fn
) {
  const results =
    await Promise.allSettled(
      items.map(fn)
    );

  return results.map(
    (result, index) => {
      if (
        result.status === "fulfilled"
      ) {
        return result.value;
      }

      return {
        ok: false,
        provider:
          items[index]?.id,
        error:
          result.reason?.message ||
          "Unknown error"
      };
    }
  );
}

/* =========================================================
   CACHE
   ========================================================= */

async function getCache(
  key
) {
  try {
    const cache =
      caches.default;

    const response =
      await cache.match(key);

    if (!response) {
      return null;
    }

    return response.clone();

  } catch {
    return null;
  }
}

async function putCache(
  key,
  response,
  ttl
) {
  try {
    const cache =
      caches.default;

    const cached =
      new Response(
        response.body,
        response
      );

    cached.headers.set(
      "Cache-Control",
      `public, max-age=${ttl}`
    );

    await cache.put(
      key,
      cached
    );

  } catch (error) {
    console.error(
      "Cache error:",
      error
    );
  }
}

function createCacheKey(
  namespace,
  data
) {
  const url =
    new URL(
      `https://cache.prophecy.internal/${namespace}`
    );

  for (
    const [key, value]
    of Object.entries(data)
  ) {
    url.searchParams.set(
      key,
      value == null
        ? ""
        : String(value)
    );
  }

  return new Request(
    url.toString(),
    {
      method: "GET"
    }
  );
}

/* =========================================================
   TEMPLATE ENGINE
   ========================================================= */

function template(
  value,
  params,
  provider,
  env
) {
  return String(value)
    .replace(
      /\{([^}]+)\}/g,
      (_, key) => {
        const result =
          resolveTemplateValue(
            `{${key}}`,
            params,
            provider,
            env
          );

        return result == null
          ? ""
          : String(result);
      }
    );
}

function resolveTemplateValue(
  value,
  params,
  provider,
  env
) {
  if (
    typeof value !== "string"
  ) {
    return value;
  }

  return value.replace(
    /\{([^}]+)\}/g,
    (_, key) => {
      if (
        Object.prototype.hasOwnProperty.call(
          params,
          key
        )
      ) {
        return params[key] ?? "";
      }

      if (
        key === "provider"
      ) {
        return provider.id;
      }

      if (
        key.startsWith("env:")
      ) {
        const envKey =
          key.slice(4);

        return env[envKey] || "";
      }

      if (
        env[key] !== undefined
      ) {
        return env[key];
      }

      return "";
    }
  );
}

function resolveObjectTemplates(
  object,
  params,
  provider,
  env
) {
  if (Array.isArray(object)) {
    return object.map(item =>
      resolveObjectTemplates(
        item,
        params,
        provider,
        env
      )
    );
  }

  if (
    object &&
    typeof object === "object"
  ) {
    const output = {};

    for (
      const [key, value]
      of Object.entries(object)
    ) {
      output[key] =
        resolveObjectTemplates(
          value,
          params,
          provider,
          env
        );
    }

    return output;
  }

  return resolveTemplateValue(
    object,
    params,
    provider,
    env
  );
}

/* =========================================================
   HELPERS
   ========================================================= */

function joinUrl(
  base,
  path
) {
  if (!base) {
    return path;
  }

  if (!path) {
    return base;
  }

  return (
    base.replace(/\/+$/, "") +
    "/" +
    path.replace(/^\/+/, "")
  );
}

function getPath(
  object,
  path
) {
  return String(path)
    .split(".")
    .reduce(
      (current, key) =>
        current == null
          ? undefined
          : current[key],
      object
    );
}

function firstValue(
  object,
  keys
) {
  for (const key of keys) {
    if (
      object &&
      object[key] !== undefined &&
      object[key] !== null &&
      object[key] !== ""
    ) {
      return object[key];
    }
  }

  return null;
}

function normalizeArray(
  value
) {
  if (Array.isArray(value)) {
    return value;
  }

  if (
    typeof value === "string"
  ) {
    return value
      .split(",")
      .map(x => x.trim())
      .filter(Boolean);
  }

  return [];
}

function normalizeType(
  value
) {
  const type =
    String(
      value || "unknown"
    ).toLowerCase();

  if (
    type.includes("anime")
  ) {
    return "anime";
  }

  if (
    type.includes("movie") ||
    type.includes("film")
  ) {
    return "movie";
  }

  if (
    type.includes("kdrama") ||
    type.includes("k-drama") ||
    type.includes("k drama")
  ) {
    return "kdrama";
  }

  if (
    type.includes("tv") ||
    type.includes("series") ||
    type.includes("show")
  ) {
    return "tv";
  }

  return "unknown";
}

function normalizeTitle(
  value
) {
  return String(
    value || ""
  )
    .toLowerCase()
    .replace(
      /[^\p{L}\p{N}]+/gu,
      " "
    )
    .trim();
}

function cleanText(
  value
) {
  if (!value) {
    return "";
  }

  return String(value)
    .trim()
    .slice(0, 300);
}

function parseNumber(
  value
) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

function toNumber(
  value
) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

function normalizeMethod(
  method
) {
  return String(
    method || "GET"
  ).toUpperCase();
}

function sleep(
  ms
) {
  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );
}

/* =========================================================
   RESPONSE HELPERS
   ========================================================= */

function json(
  data,
  status = 200
) {
  const response =
    new Response(
      JSON.stringify(
        data,
        null,
        2
      ),
      {
        status,
        headers: {
          "Content-Type":
            "application/json; charset=utf-8",
          "Cache-Control":
            "no-store"
        }
      }
    );

  return corsResponse(
    response
  );
}

function errorResponse(
  code,
  message,
  status
) {
  return json(
    {
      ok: false,
      error: {
        code,
        message
      }
    },
    status
  );
}

function corsResponse(
  response
) {
  const headers =
    new Headers(
      response.headers
    );

  headers.set(
    "Access-Control-Allow-Origin",
    "*"
  );

  headers.set(
    "Access-Control-Allow-Methods",
    "GET, OPTIONS"
  );

  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  return new Response(
    response.body,
    {
      status:
        response.status,
      statusText:
        response.statusText,
      headers
    }
  );
}
