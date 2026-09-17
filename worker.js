/**
 * Open Source Provider
 * Powered by Prophecy
 *
 * Cloudflare Worker
 *
 * Responsibilities:
 * - Provider registry loading
 * - Request validation
 * - Parallel provider discovery
 * - Timeout + retry
 * - Caching
 * - CORS
 * - Rate limiting hooks
 * - Unified response format
 *
 * Provider-specific configuration lives in providers.json.
 */

const VERSION = "1.0.0";

const DEFAULTS = {
  timeoutMs: 7000,
  retries: 1,
  cacheTtl: 300,
  maxProviders: 20,
  maxResults: 100
};

// --------------------------------------------------
// CORS
// --------------------------------------------------

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400"
};

// --------------------------------------------------
// Main Worker
// --------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: CORS_HEADERS
        });
      }

      const url = new URL(request.url);

      if (url.pathname === "/") {
        return json({
          success: true,
          name: "Open Source Provider",
          poweredBy: "Prophecy",
          version: VERSION,
          status: "online"
        });
      }

      if (url.pathname === "/health") {
        return json({
          success: true,
          status: "healthy",
          version: VERSION,
          timestamp: new Date().toISOString()
        });
      }

      if (url.pathname === "/providers") {
        const providers = await loadProviders(env);

        return json({
          success: true,
          count: providers.length,
          providers: providers.map(publicProviderInfo)
        });
      }

      if (url.pathname === "/search") {
        return await handleSearch(request, env, ctx);
      }

      if (url.pathname === "/resolve") {
        return await handleResolve(request, env, ctx);
      }

      return errorResponse(
        "NOT_FOUND",
        "Endpoint not found",
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

// --------------------------------------------------
// SEARCH
// --------------------------------------------------

async function handleSearch(request, env, ctx) {
  const url = new URL(request.url);

  const query = cleanString(
    url.searchParams.get("q")
  );

  const type = cleanString(
    url.searchParams.get("type")
  );

  const season = toPositiveInt(
    url.searchParams.get("season")
  );

  const episode = toPositiveInt(
    url.searchParams.get("episode")
  );

  if (!query) {
    return errorResponse(
      "INVALID_REQUEST",
      "Search query is required",
      400
    );
  }

  if (query.length > 200) {
    return errorResponse(
      "INVALID_REQUEST",
      "Search query is too long",
      400
    );
  }

  const providers = await loadProviders(env);

  const enabledProviders = providers
    .filter(provider => provider.enabled !== false)
    .filter(provider => supportsType(provider, type))
    .slice(0, DEFAULTS.maxProviders);

  if (!enabledProviders.length) {
    return json({
      success: true,
      query,
      results: [],
      providers: [],
      count: 0
    });
  }

  const cacheKey = new Request(
    new URL(
      `/__cache/search?q=${encodeURIComponent(query)}&type=${encodeURIComponent(type || "")}&season=${season || ""}&episode=${episode || ""}`,
      url.origin
    ),
    { method: "GET" }
  );

  const cached = await caches.default.match(cacheKey);

  if (cached) {
    const data = await cached.json();

    return json({
      ...data,
      cached: true
    });
  }

  const startedAt = Date.now();

  const tasks = enabledProviders.map(provider =>
    queryProvider(
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

  const settled = await Promise.allSettled(tasks);

  const results = [];
  const providerStatus = [];

  for (let i = 0; i < settled.length; i++) {
    const provider = enabledProviders[i];
    const result = settled[i];

    if (result.status === "fulfilled") {
      const providerResult = result.value;

      providerStatus.push({
        id: provider.id,
        status: "ONLINE",
        count: providerResult.length
      });

      results.push(
        ...providerResult
      );
    } else {
      providerStatus.push({
        id: provider.id,
        status: "ERROR",
        count: 0
      });

      console.error(
        `Provider ${provider.id} failed:`,
        result.reason
      );
    }
  }

  const normalized = normalizeResults(results);

  const responseData = {
    success: true,
    query,
    type: type || null,
    season: season || null,
    episode: episode || null,
    count: Math.min(
      normalized.length,
      DEFAULTS.maxResults
    ),
    results: normalized.slice(
      0,
      DEFAULTS.maxResults
    ),
    providers: providerStatus,
    latencyMs: Date.now() - startedAt,
    cached: false
  };

  const response = json(responseData);

  ctx.waitUntil(
    cacheResponse(
      cacheKey,
      response.clone(),
      DEFAULTS.cacheTtl
    )
  );

  return response;
}

// --------------------------------------------------
// RESOLVE
// --------------------------------------------------

async function handleResolve(request, env, ctx) {
  const url = new URL(request.url);

  const providerId = cleanString(
    url.searchParams.get("provider")
  );

  const itemId = cleanString(
    url.searchParams.get("id")
  );

  if (!providerId || !itemId) {
    return errorResponse(
      "INVALID_REQUEST",
      "provider and id are required",
      400
    );
  }

  const providers = await loadProviders(env);

  const provider = providers.find(
    p => p.id === providerId
  );

  if (!provider) {
    return errorResponse(
      "PROVIDER_NOT_FOUND",
      "Provider does not exist",
      404
    );
  }

  if (provider.enabled === false) {
    return errorResponse(
      "PROVIDER_DISABLED",
      "Provider is disabled",
      403
    );
  }

  const result = await resolveProvider(
    provider,
    itemId,
    env
  );

  return json({
    success: true,
    provider: provider.id,
    result
  });
}

// --------------------------------------------------
// PROVIDER LOADING
// --------------------------------------------------

async function loadProviders(env) {
  /*
   * Recommended:
   *
   * providers.json should be bundled with the Worker.
   *
   * Example import:
   *
   * import PROVIDERS from "./providers.json";
   *
   * If you use that method, replace this function
   * with the imported JSON.
   */

  if (env.PROVIDERS_JSON) {
    try {
      const parsed = JSON.parse(
        env.PROVIDERS_JSON
      );

      return Array.isArray(parsed)
        ? parsed
        : parsed.providers || [];
    } catch {
      console.error(
        "Invalid PROVIDERS_JSON"
      );
    }
  }

  /*
   * Fallback empty registry.
   *
   * Replace with:
   *
   * import PROVIDERS from "./providers.json";
   *
   * when deploying the final version.
   */

  return [];
}

// --------------------------------------------------
// PROVIDER SEARCH
// --------------------------------------------------

async function queryProvider(
  provider,
  params,
  env
) {
  const endpoint = buildEndpoint(
    provider,
    params
  );

  if (!endpoint) {
    return [];
  }

  const headers = buildHeaders(
    provider,
    env
  );

  const response = await fetchWithRetry(
    endpoint,
    {
      method: provider.method || "GET",
      headers
    },
    provider.timeoutMs || DEFAULTS.timeoutMs,
    provider.retries ?? DEFAULTS.retries
  );

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}`
    );
  }

  const contentType =
    response.headers.get(
      "content-type"
    ) || "";

  if (!contentType.includes("json")) {
    throw new Error(
      "Provider returned non-JSON response"
    );
  }

  const data = await response.json();

  return extractProviderResults(
    provider,
    data
  );
}

// --------------------------------------------------
// PROVIDER RESOLVE
// --------------------------------------------------

async function resolveProvider(
  provider,
  itemId,
  env
) {
  if (!provider.resolve) {
    return {
      id: itemId,
      url: null,
      playable: false,
      message: "Provider does not expose a resolver"
    };
  }

  const endpoint = buildResolveEndpoint(
    provider,
    itemId
  );

  if (!endpoint) {
    return {
      id: itemId,
      url: null,
      playable: false
    };
  }

  const headers = buildHeaders(
    provider,
    env
  );

  const response = await fetchWithRetry(
    endpoint,
    {
      method: provider.resolve.method || "GET",
      headers
    },
    provider.resolve.timeoutMs ||
      DEFAULTS.timeoutMs,
    provider.resolve.retries ??
      DEFAULTS.retries
  );

  if (!response.ok) {
    throw new Error(
      `Resolver HTTP ${response.status}`
    );
  }

  const data = await response.json();

  return normalizePlayback(
    provider,
    data
  );
}

// --------------------------------------------------
// URL BUILDING
// --------------------------------------------------

function buildEndpoint(
  provider,
  params
) {
  if (!provider.search?.url) {
    return null;
  }

  let endpoint = provider.search.url;

  endpoint = endpoint.replace(
    /\{query\}/g,
    encodeURIComponent(params.query || "")
  );

  endpoint = endpoint.replace(
    /\{type\}/g,
    encodeURIComponent(params.type || "")
  );

  endpoint = endpoint.replace(
    /\{season\}/g,
    encodeURIComponent(params.season || "")
  );

  endpoint = endpoint.replace(
    /\{episode\}/g,
    encodeURIComponent(params.episode || "")
  );

  return endpoint;
}

function buildResolveEndpoint(
  provider,
  itemId
) {
  if (!provider.resolve?.url) {
    return null;
  }

  return provider.resolve.url.replace(
    /\{id\}/g,
    encodeURIComponent(itemId)
  );
}

// --------------------------------------------------
// HEADERS / AUTH
// --------------------------------------------------

function buildHeaders(
  provider,
  env
) {
  const headers = {
    Accept: "application/json"
  };

  const auth = provider.auth;

  if (!auth) {
    return headers;
  }

  /*
   * Secret values should be stored in
   * Cloudflare Worker Secrets.
   *
   * providers.json contains only the
   * secret name, never the actual secret.
   */

  if (
    auth.type === "bearer" &&
    auth.secretName
  ) {
    const token =
      env[auth.secretName];

    if (token) {
      headers.Authorization =
        `Bearer ${token}`;
    }
  }

  if (
    auth.type === "api-key" &&
    auth.secretName &&
    auth.header
  ) {
    const key =
      env[auth.secretName];

    if (key) {
      headers[auth.header] = key;
    }
  }

  return headers;
}

// --------------------------------------------------
// FETCH WITH TIMEOUT + RETRY
// --------------------------------------------------

async function fetchWithRetry(
  input,
  init,
  timeoutMs,
  retries
) {
  let lastError;

  for (
    let attempt = 0;
    attempt <= retries;
    attempt++
  ) {
    try {
      return await fetchWithTimeout(
        input,
        init,
        timeoutMs
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

  throw lastError;
}

async function fetchWithTimeout(
  input,
  init,
  timeoutMs
) {
  const controller =
    new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    return await fetch(
      input,
      {
        ...init,
        signal: controller.signal
      }
    );
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}

// --------------------------------------------------
// RESULT NORMALIZATION
// --------------------------------------------------

function extractProviderResults(
  provider,
  data
) {
  let items = [];

  if (
    provider.response?.resultsPath
  ) {
    items =
      getPath(
        data,
        provider.response.resultsPath
      ) || [];
  } else if (Array.isArray(data)) {
    items = data;
  } else if (Array.isArray(data.results)) {
    items = data.results;
  } else if (Array.isArray(data.data)) {
    items = data.data;
  }

  if (!Array.isArray(items)) {
    return [];
  }

  return items.map(item =>
    normalizeItem(
      provider,
      item
    )
  );
}

function normalizeItem(
  provider,
  item
) {
  const mapping =
    provider.response?.mapping || {};

  return {
    provider: provider.id,

    providerItemId:
      readMapping(
        item,
        mapping.id
      ),

    title:
      readMapping(
        item,
        mapping.title
      ) || "",

    originalTitle:
      readMapping(
        item,
        mapping.originalTitle
      ) || null,

    type:
      readMapping(
        item,
        mapping.type
      ) || "unknown",

    year:
      toNumber(
        readMapping(
          item,
          mapping.year
        )
      ),

    season:
      toNumber(
        readMapping(
          item,
          mapping.season
        )
      ),

    episode:
      toNumber(
        readMapping(
          item,
          mapping.episode
        )
      ),

    episodeTitle:
      readMapping(
        item,
        mapping.episodeTitle
      ) || null,

    url:
      readMapping(
        item,
        mapping.url
      ) || null,

    urlType:
      detectUrlType(
        readMapping(
          item,
          mapping.url
        )
      ),

    language:
      normalizeArray(
        readMapping(
          item,
          mapping.language
        )
      ),

    subtitle:
      normalizeArray(
        readMapping(
          item,
          mapping.subtitle
        )
      ),

    duration:
      toNumber(
        readMapping(
          item,
          mapping.duration
        )
      ),

    thumbnail:
      readMapping(
        item,
        mapping.thumbnail
      ) || null,

    license:
      readMapping(
        item,
        mapping.license
      ) || null,

    rights:
      readMapping(
        item,
        mapping.rights
      ) || null
  };
}

// --------------------------------------------------
// PLAYBACK NORMALIZATION
// --------------------------------------------------

function normalizePlayback(
  provider,
  data
) {
  const mapping =
    provider.resolve?.mapping || {};

  const url =
    readMapping(
      data,
      mapping.url
    );

  return {
    provider: provider.id,

    url: url || null,

    urlType:
      detectUrlType(url),

    playable:
      Boolean(url),

    expiresAt:
      readMapping(
        data,
        mapping.expiresAt
      ) || null,

    subtitles:
      normalizeArray(
        readMapping(
          data,
          mapping.subtitles
        )
      ),

    headers:
      mapping.forwardHeaders
        ? readMapping(
            data,
            mapping.forwardHeaders
          )
        : undefined
  };
}

// --------------------------------------------------
// NORMALIZATION HELPERS
// --------------------------------------------------

function normalizeResults(
  results
) {
  const seen = new Set();
  const output = [];

  for (const item of results) {
    const key = [
      normalizeTitle(item.title),
      item.type,
      item.season || "",
      item.episode || "",
      item.url || ""
    ].join("|");

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    output.push(item);
  }

  return output;
}

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(
      /[^\p{L}\p{N}]+/gu,
      " "
    )
    .replace(/\s+/g, " ");
}

function normalizeArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return [];
  }

  return [value];
}

function detectUrlType(url) {
  if (!url) {
    return "unknown";
  }

  const value =
    String(url).toLowerCase();

  if (value.includes(".m3u8")) {
    return "hls";
  }

  if (value.includes(".mpd")) {
    return "dash";
  }

  if (value.includes(".mp4")) {
    return "mp4";
  }

  if (value.includes(".webm")) {
    return "webm";
  }

  return "page";
}

// --------------------------------------------------
// TYPE FILTER
// --------------------------------------------------

function supportsType(
  provider,
  type
) {
  if (!type) {
    return true;
  }

  if (
    !provider.types ||
    !Array.isArray(provider.types)
  ) {
    return true;
  }

  return provider.types.includes(
    type
  );
}

// --------------------------------------------------
// PATH / MAPPING
// --------------------------------------------------

function getPath(
  object,
  path
) {
  if (!path) {
    return object;
  }

  return String(path)
    .split(".")
    .reduce(
      (value, key) =>
        value == null
          ? undefined
          : value[key],
      object
    );
}

function readMapping(
  object,
  path
) {
  if (!path) {
    return undefined;
  }

  if (
    typeof path === "string"
  ) {
    return getPath(
      object,
      path
    );
  }

  return undefined;
}

// --------------------------------------------------
// PUBLIC PROVIDER INFO
// --------------------------------------------------

function publicProviderInfo(
  provider
) {
  return {
    id: provider.id,
    name: provider.name || provider.id,
    enabled:
      provider.enabled !== false,
    types:
      provider.types || [],
    auth:
      provider.auth
        ? provider.auth.type
        : "none",
    capabilities:
      provider.capabilities || {}
  };
}

// --------------------------------------------------
// CACHE
// --------------------------------------------------

async function cacheResponse(
  request,
  response,
  ttl
) {
  const headers =
    new Headers(
      response.headers
    );

  headers.set(
    "Cache-Control",
    `public, max-age=${ttl}`
  );

  const cachedResponse =
    new Response(
      await response.text(),
      {
        status: response.status,
        headers
      }
    );

  await caches.default.put(
    request,
    cachedResponse
  );
}

// --------------------------------------------------
// INPUT HELPERS
// --------------------------------------------------

function cleanString(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  return String(value).trim();
}

function toPositiveInt(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const number =
    Number(value);

  if (
    !Number.isInteger(number) ||
    number < 1
  ) {
    return null;
  }

  return number;
}

function toNumber(value) {
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

// --------------------------------------------------
// RESPONSE HELPERS
// --------------------------------------------------

function json(
  data,
  status = 200
) {
  const headers = {
    ...CORS_HEADERS,
    "Content-Type":
      "application/json; charset=utf-8",
    "X-Prophecy-Version":
      VERSION
  };

  return new Response(
    JSON.stringify(
      data,
      null,
      2
    ),
    {
      status,
      headers
    }
  );
}

function errorResponse(
  code,
  message,
  status
) {
  return json(
    {
      success: false,
      error: {
        code,
        message
      }
    },
    status
  );
}
