import PROVIDER_CONFIG from "./providers.json";

const VERSION = "3.0.0";
const DEFAULTS = {
  timeoutMs: 8000,
  retries: 1,
  cacheTtlSeconds: 300,
  maxProviders: 50,
  maxResultsPerProvider: 50,
  maxTotalResults: 200,
  maxQueryLength: 300
};
const METHODS = new Set(["GET", "POST"]);
const MEDIA_TYPES = new Set(["hls", "dash", "mp4", "webm", "ogv", "ogg"]);
const ERROR_CODES = new Set([
  "INVALID_REQUEST", "PROVIDER_TIMEOUT", "PROVIDER_ERROR", "HTTP_ERROR",
  "AUTH_REQUIRED", "FORBIDDEN", "NOT_FOUND", "RATE_LIMITED", "NO_RESULTS",
  "INTERNAL_ERROR", "PROVIDER_NOT_FOUND", "RESOLVE_NOT_SUPPORTED"
]);

function allProviders() {
  return Array.isArray(PROVIDER_CONFIG) ? PROVIDER_CONFIG : (PROVIDER_CONFIG?.providers || []);
}
function enabledProviders() { return allProviders().filter(p => p && p.enabled !== false); }
function providerById(id) { return enabledProviders().find(p => p.id === id); }

export default {
  async fetch(request, env = {}, ctx = { waitUntil() {} }) {
    try {
      if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
      const url = new URL(request.url);
      if (request.method !== "GET") return errorResponse("INVALID_REQUEST", "Only GET and OPTIONS are supported", 405);
      if (url.pathname === "/") return json({ ok: true, name: "Open Source Provider", service: "Open Source Provider", poweredBy: "Prophecy", version: VERSION, providers: enabledProviders().length });
      if (url.pathname === "/health") return json({ ok: true, status: "online", version: VERSION, providerCount: allProviders().length, enabledProviderCount: enabledProviders().length, timestamp: new Date().toISOString() });
      if (url.pathname === "/providers") return handleProviders(url);
      if (url.pathname === "/search") return await handleSearch(request, env, ctx);
      if (url.pathname === "/resolve") return await handleResolve(request, env);
      return errorResponse("NOT_FOUND", "Route not found", 404);
    } catch (error) {
      console.error("Worker error", error);
      return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
    }
  }
};

function handleProviders(url) {
  const includeDisabled = url.searchParams.get("includeDisabled") === "true";
  const list = (includeDisabled ? allProviders() : enabledProviders()).map(p => ({
    id: p.id, name: p.name || p.id, category: p.category || "unknown", enabled: p.enabled !== false,
    instanceRequired: !!p.instance_required, capabilities: { ...(p.capabilities || {}) },
    authentication: { required: !!p.authentication?.required, type: p.authentication?.type || "none" },
    rights: p.rights || null
  }));
  return json({ ok: true, count: list.length, providers: list });
}

async function handleSearch(request, env, ctx) {
  const url = new URL(request.url);
  const original = cleanText(url.searchParams.get("q"));
  if (!original) return errorResponse("INVALID_REQUEST", "Missing q parameter", 400);
  const query = parseQuery(original, url.searchParams);
  const requestedProvider = cleanText(url.searchParams.get("provider"));
  const category = cleanText(url.searchParams.get("category"));
  const capability = cleanText(url.searchParams.get("capability"));
  let providers = enabledProviders().filter(p => p.search?.enabled !== false && p.capabilities?.search !== false);
  if (requestedProvider) providers = providers.filter(p => p.id === requestedProvider);
  if (category) providers = providers.filter(p => p.category === category);
  if (capability) providers = providers.filter(p => p.capabilities?.[capability] === true);
  providers = providers.slice(0, DEFAULTS.maxProviders);

  const cacheKey = createCacheKey("search", { q: query.searchQuery, original: query.originalQuery, type: query.type || "", season: query.season ?? "", episode: query.episode ?? "", year: query.year ?? "", provider: requestedProvider || "all", category, capability });
  const bypassCache = url.searchParams.get("cache") === "false";
  const cached = bypassCache ? null : await getCache(cacheKey);
  if (cached) return cached;
  const outcomes = await Promise.allSettled(providers.map(p => searchProvider(p, query, env)));
  const successful = [], failures = [];
  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i];
    if (outcome.status === "fulfilled" && outcome.value.ok) successful.push(...outcome.value.results);
    else {
      const value = outcome.status === "fulfilled" ? outcome.value : { code: classifyError(outcome.reason), message: safeError(outcome.reason) };
      failures.push({ provider: providers[i]?.id, code: value.code || "PROVIDER_ERROR", message: value.message || value.error || "Provider failed" });
    }
  }
  const results = dedupe(successful).filter(r => matchesQuery(r, query)).slice(0, DEFAULTS.maxTotalResults);
  const response = json({ ok: true, query: { original: query.originalQuery, q: query.searchQuery, type: query.type, season: query.season, episode: query.episode, year: query.year }, count: results.length, results, providers: { requested: providers.length, successful: providers.length - failures.length, failed: failures.length, failures } });
  if (!results.some(r => r.playback?.available && r.playback?.direct)) ctx.waitUntil(putCache(cacheKey, response.clone(), DEFAULTS.cacheTtlSeconds));
  return response;
}

async function handleResolve(request, env) {
  const url = new URL(request.url);
  const id = cleanText(url.searchParams.get("id"));
  const providerId = cleanText(url.searchParams.get("provider"));
  if (!id || !providerId) return errorResponse("INVALID_REQUEST", "provider and id are required", 400);
  const provider = providerById(providerId);
  if (!provider) return errorResponse("PROVIDER_NOT_FOUND", "Provider not found", 404);
  if (provider.resolve?.enabled === false || provider.capabilities?.resolve === false) return errorResponse("RESOLVE_NOT_SUPPORTED", "This provider does not support resolve", 400);
  const outcome = await resolveProvider(provider, { id, type: cleanText(url.searchParams.get("type")) || "unknown" }, env);
  if (!outcome.ok) return errorResponse(outcome.code, outcome.message, statusForCode(outcome.code));
  return json({ ok: true, provider: provider.id, result: outcome.result });
}

function parseQuery(original, params) {
  let searchQuery = original;
  let season = parsePositiveInt(params.get("season"));
  let episode = parsePositiveInt(params.get("episode"));
  let year = parseYear(params.get("year"));
  const seasonMatch = searchQuery.match(/(?:^|\s)(?:s(?:eason)?\s*)0*(\d{1,3})(?=\s|$)/i);
  const episodeMatch = searchQuery.match(/(?:^|\s)(?:e(?:p(?:isode)?)?\s*)0*(\d{1,4})(?=\s|$)/i);
  const longMatch = searchQuery.match(/(?:^|\s)season\s*0*(\d{1,3})\s+episode\s*0*(\d{1,4})(?=\s|$)/i);
  if (longMatch) { season ??= Number(longMatch[1]); episode ??= Number(longMatch[2]); }
  else { season ??= seasonMatch ? Number(seasonMatch[1]) : null; episode ??= episodeMatch ? Number(episodeMatch[1]) : null; }
  if (!year) { const m = searchQuery.match(/(?:^|\s)((?:19|20)\d{2})(?=\s|$)/); if (m) year = Number(m[1]); }
  searchQuery = searchQuery
    .replace(/(?:^|\s)(?:season\s*0*\d{1,3}\s+episode\s*0*\d{1,4})(?=\s|$)/ig, " ")
    .replace(/(?:^|\s)(?:s(?:eason)?\s*0*\d{1,3})(?=\s|$)/ig, " ")
    .replace(/(?:^|\s)(?:e(?:p(?:isode)?)?\s*0*\d{1,4})(?=\s|$)/ig, " ")
    .replace(/(?:^|\s)(?:19|20)\d{2}(?=\s|$)/g, " ");
  searchQuery = cleanText(searchQuery).replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
  const type = cleanText(params.get("type")) || inferType(original);
  return { originalQuery: original, searchQuery, type: type || null, season, episode, year };
}
function inferType(q) { return /\banime\b/i.test(q) ? "anime" : null; }
function parsePositiveInt(v) { if (v == null || !/^\d+$/.test(String(v))) return null; const n = Number(v); return n > 0 ? n : null; }
function parseYear(v) { const n = parsePositiveInt(v); return n && n >= 1900 && n <= 2100 ? n : null; }

async function searchProvider(provider, query, env) {
  if (provider.instance_required && (!provider.baseUrl || provider.baseUrl.includes("INSTANCE"))) return failure(provider, "PROVIDER_ERROR", "Provider instance URL is missing");
  try {
    const config = provider.search || {};
    const target = buildRequest(provider, config, { ...query, query: query.searchQuery }, env);
    const response = await fetchWithRetry(target, provider);
    if (!response.ok) return failure(provider, ...httpFailure(response.status));
    const data = await parseResponse(response);
    const items = extractResults(data, provider.response?.resultsPath || config.resultsPath);
    const results = items.slice(0, DEFAULTS.maxResultsPerProvider).map(item => normalizeResult(item, provider, query)).filter(Boolean);
    return { ok: true, provider: provider.id, results };
  } catch (error) { return failure(provider, classifyError(error), safeError(error)); }
}
async function resolveProvider(provider, params, env) {
  try {
    const target = buildRequest(provider, provider.resolve || {}, params, env);
    const response = await fetchWithRetry(target, provider);
    if (!response.ok) { const [code, message] = httpFailure(response.status); return { ok: false, code, message }; }
    const data = await parseResponse(response);
    const item = Array.isArray(data) ? data[0] : data;
    const result = normalizeResult(item, provider, params);
    return result ? { ok: true, result } : { ok: false, code: "NO_RESULTS", message: "Provider returned no valid result" };
  } catch (error) { return { ok: false, code: classifyError(error), message: safeError(error) }; }
}
function failure(provider, code, message) { return { ok: false, provider: provider.id, code, message }; }

function buildRequest(provider, config, params, env) {
  const base = config.baseUrl || provider.apiBaseUrl || provider.baseUrl || "";
  let path = expand(config.path || "", params, provider, env);
  let raw = /^https?:\/\//i.test(path) ? path : joinUrl(base, path);
  const url = safeUrl(raw);
  if (!url) throw new Error("Invalid provider URL");
  for (const [key, value] of Object.entries(config.query || {})) {
    const resolved = expandValue(value, params, provider, env);
    if (resolved !== "" && resolved != null) url.searchParams.set(key, String(resolved));
  }
  const headers = { Accept: "application/json", ...resolveHeaders(config.headers, params, provider, env) };
  let body;
  if (config.body && typeof config.body === "object") { body = JSON.stringify(resolveObject(config.body, params, provider, env)); headers["Content-Type"] = "application/json"; }
  return { url: url.toString(), options: { method: String(config.method || "GET").toUpperCase(), headers, body } };
}
function resolveHeaders(headers, params, provider, env) { const out = {}; for (const [k, v] of Object.entries(headers || {})) out[k] = String(expandValue(v, params, provider, env)); return out; }
function resolveObject(value, params, provider, env) { if (Array.isArray(value)) return value.map(v => resolveObject(v, params, provider, env)); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveObject(v, params, provider, env)])); return expandValue(value, params, provider, env); }
function expand(value, params, provider, env) { return String(value).replace(/\{([^}]+)\}/g, (_, key) => String(resolveKey(key, params, provider, env) ?? "")); }
function expandValue(value, params, provider, env) { return typeof value === "string" ? expand(value, params, provider, env) : value; }
function resolveKey(key, params, provider, env) {
  if (key.startsWith("secret:")) return env[key.slice(7)] || "";
  if (key.startsWith("env:")) return env[key.slice(4)] || "";
  if (Object.prototype.hasOwnProperty.call(params, key)) return params[key];
  if (key === "provider") return provider.id;
  return env[key] ?? "";
}
function safeUrl(value) { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url : null; } catch { return null; } }
function joinUrl(base, path) { return `${String(base).replace(/\/+$/, "")}/${String(path).replace(/^\/+/, "")}`; }

async function fetchWithRetry(target, provider) {
  const method = target.options.method;
  if (!METHODS.has(method)) throw new Error(`Unsupported method: ${method}`);
  const retries = Math.max(0, Math.min(3, Number.isInteger(provider.retries) ? provider.retries : DEFAULTS.retries));
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try { return await fetchWithTimeout(target.url, target.options, Number(provider.timeoutMs) || DEFAULTS.timeoutMs); }
    catch (error) { last = error; if (attempt < retries) await sleep(150 * (attempt + 1)); }
  }
  throw last || new Error("Provider request failed");
}
async function fetchWithTimeout(url, options, timeoutMs) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); try { return await fetch(url, { ...options, redirect: "follow", signal: controller.signal }); } finally { clearTimeout(timer); } }
async function parseResponse(response) { const text = await response.text(); try { return JSON.parse(text); } catch { return { text }; } }
function extractResults(data, path) {
  if (path) { const configured = getPath(data, path); if (Array.isArray(configured)) return configured; if (configured && typeof configured === "object") return [configured]; }
  if (Array.isArray(data)) return data;
  for (const candidate of [data?.results, data?.items, data?.data, data?.videos, data?.entries, data?.records, data?.response?.docs, data?.data?.items]) if (Array.isArray(candidate)) return candidate;
  return data && typeof data === "object" ? [data] : [];
}

function normalizeResult(item, provider, request) {
  if (!item || typeof item !== "object") return null;
  const mapping = provider.response?.mapping || {};
  const get = (field, fallback = []) => firstPath(item, [].concat(mapping[field] || fallback));
  const title = cleanText(get("title", ["title", "name", "display_name", "label"]));
  const idValue = get("id", ["id", "uuid", "videoId", "video_id", "identifier", "slug"]);
  const rawUrl = get("url", ["url", "videoUrl", "video_url", "mediaUrl", "media_url", "playbackUrl", "playback_url", "streamUrl", "stream_url", "file", "src", "source"]);
  const id = idValue == null ? "" : String(idValue).trim();
  const pageUrl = normalizeUrl(rawUrl, provider);
  const season = toNumber(get("season", ["season", "season_number", "seasonNumber"]));
  const episode = toNumber(get("episode", ["episode", "episode_number", "episodeNumber", "episode_no"]));
  const playback = detectPlayback(pageUrl, provider, item);
  const validation = provider.validation || {};
  if (validation.requireTitle !== false && !title) return null;
  if (validation.requireIdOrUrl !== false && !id && !pageUrl) return null;
  if (!title && !id && !pageUrl) return null;
  if (request.season != null && season != null && request.season !== season) return null;
  if (request.episode != null && episode != null && request.episode !== episode) return null;
  return {
    provider: provider.id, providerName: provider.name || provider.id, providerItemId: id || null, title: title || null,
    originalTitle: cleanText(get("originalTitle", ["originalTitle", "original_title"])) || null,
    type: normalizeType(get("type", ["type", "media_type", "content_type"]) || request.type),
    year: toNumber(get("year", ["year", "releaseYear", "release_year"])), season, episode,
    episodeTitle: cleanText(get("episodeTitle", ["episodeTitle", "episode_title"])) || null,
    url: pageUrl, urlType: playback.type, language: normalizeArray(get("language", ["language", "languages", "lang"])), subtitle: normalizeArray(get("subtitles", ["subtitle", "subtitles", "captions"])),
    duration: toNumber(get("duration", ["duration", "durationSeconds", "duration_seconds"])), thumbnail: normalizeUrl(get("thumbnail", ["thumbnail", "thumbnailUrl", "thumbnail_url", "poster", "image"]), provider),
    license: get("license", ["license", "licence"]) || provider.rights?.license || null, rights: provider.rights || null, playback
  };
}
function normalizeUrl(raw, provider) { if (typeof raw !== "string" || !raw.trim()) return null; try { const base = provider.apiBaseUrl || provider.baseUrl; const url = new URL(raw.trim(), base); return ["http:", "https:"].includes(url.protocol) ? url.toString() : null; } catch { return null; } }
function detectPlayback(url, provider, item) {
  const metadataOnly = provider.capabilities?.playback === false || provider.playback?.enabled === false;
  if (!url || metadataOnly) return { available: false, direct: false, type: url ? "page" : "unknown" };
  const path = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return ""; } })();
  let type = path.endsWith(".m3u8") ? "hls" : path.endsWith(".mpd") ? "dash" : path.endsWith(".mp4") ? "mp4" : path.endsWith(".webm") ? "webm" : (path.endsWith(".ogv") || path.endsWith(".ogg")) ? "ogv" : "page";
  const configured = (provider.playback?.types || []).map(String).map(x => x.toLowerCase().replace("m3u8", "hls"));
  const explicit = item?.isDirect === true || item?.direct === true || item?.urlType === "direct" || provider.playback?.directUrl === true && MEDIA_TYPES.has(type);
  const direct = explicit && type !== "page" && (configured.length === 0 || configured.includes(type));
  return { available: direct, direct, type: direct ? type : "page" };
}
function matchesQuery(result, query) {
  if (!result.title) return false;
  const wanted = normalizeTitle(query.searchQuery), title = normalizeTitle(result.title), original = normalizeTitle(result.originalTitle || "");
  if (!wanted) return false;
  const excluded = /[#]|\b(gameplay|game|reaction|review|amv|ost|soundtrack|trailer|fan edit|fanedit|favorites?|discussion|official teaser|recap|bonus|behind the scenes|manga|maxxing|aesthetics|shitty advice)\b/i;
  if (excluded.test(title)) return false;
  const exact = title === wanted || original === wanted;
  const strong = title.includes(wanted) || wanted.includes(title);
  if (!exact && !strong) return false;
  if (query.season != null) {
    const explicitSeason = title.match(/(?:\bseason|\bs)[\s._-]*0*(\d{1,3})\b/i);
    if (explicitSeason && Number(explicitSeason[1]) !== query.season) return false;
  }
  if (query.episode != null) {
    const compactEpisode = title.match(/\bs\s*0*\d{1,3}[\s._-]*e\s*0*(\d{1,4})\b/i);
    const explicitEpisode = title.match(/(?:\bepisode|\bep|\be)[\s._-]*0*(\d{1,4})\b/i);
    const episodeNumber = compactEpisode ? Number(compactEpisode[1]) : explicitEpisode ? Number(explicitEpisode[1]) : null;
    if (episodeNumber != null && episodeNumber !== query.episode) return false;
  }
  if (query.year != null && result.year != null && query.year !== result.year) return false;
  if (query.season != null && result.season != null && query.season !== result.season) return false;
  if (query.episode != null && result.episode != null && query.episode !== result.episode) return false;
  return true;
}
function dedupe(results) { const seen = new Set(), output = []; for (const result of results) { const key = result.providerItemId ? `${result.provider}|${result.providerItemId}` : `${normalizeTitle(result.title)}|${result.season || ""}|${result.episode || ""}|${result.url || ""}`; if (!seen.has(key)) { seen.add(key); output.push(result); } } return output; }
function firstPath(object, paths) { for (const path of paths) { const value = getPath(object, path); if (value !== undefined && value !== null && value !== "") return value; } return null; }
function getPath(object, path) { return String(path).split(".").reduce((value, key) => value == null ? undefined : value[key], object); }
function normalizeTitle(value) { return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim(); }
function normalizeType(value) { const text = String(value || "unknown").toLowerCase(); return text.includes("anime") ? "anime" : text.includes("movie") || text.includes("film") ? "movie" : text.includes("kdrama") || text.includes("k-drama") ? "kdrama" : text.includes("tv") || text.includes("series") || text.includes("show") ? "tv" : "unknown"; }
function normalizeArray(value) { return Array.isArray(value) ? value : typeof value === "string" ? value.split(",").map(x => x.trim()).filter(Boolean) : []; }
function toNumber(value) { if (value === null || value === undefined || value === "") return null; const n = Number(value); return Number.isFinite(n) ? n : null; }
function cleanText(value) { return value == null ? "" : String(value).trim().slice(0, DEFAULTS.maxQueryLength); }

function httpFailure(status) { return status === 401 ? ["AUTH_REQUIRED", "Provider authentication required"] : status === 403 ? ["FORBIDDEN", "Provider denied access"] : status === 404 ? ["NOT_FOUND", "Provider resource not found"] : status === 408 || status === 504 ? ["PROVIDER_TIMEOUT", "Provider request timed out"] : status === 429 ? ["RATE_LIMITED", "Provider rate limit reached"] : status >= 500 ? ["PROVIDER_ERROR", `Provider returned HTTP ${status}`] : status >= 400 ? ["HTTP_ERROR", `Provider returned HTTP ${status}`] : ["PROVIDER_ERROR", `Provider returned HTTP ${status}`]; }
function classifyError(error) { return error?.name === "AbortError" ? "PROVIDER_TIMEOUT" : "PROVIDER_ERROR"; }
function safeError(error) { return error?.name === "AbortError" ? "Provider request timed out" : String(error?.message || "Provider request failed").slice(0, 200); }
function statusForCode(code) { return code === "AUTH_REQUIRED" ? 401 : code === "FORBIDDEN" ? 403 : code === "NOT_FOUND" ? 404 : code === "RATE_LIMITED" ? 429 : code === "INVALID_REQUEST" ? 400 : 502; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function getCache(key) { try { return (await caches.default.match(key))?.clone() || null; } catch { return null; } }
async function putCache(key, response, ttl) { try { const cached = new Response(response.body, response); cached.headers.set("Cache-Control", `public, max-age=${ttl}`); await caches.default.put(key, cached); } catch (error) { console.error("Cache error", error); } }
function createCacheKey(namespace, data) { const url = new URL(`https://cache.prophecy.internal/${namespace}`); for (const [key, value] of Object.entries(data)) url.searchParams.set(key, value == null ? "" : String(value)); return new Request(url); }
function json(data, status = 200) { return cors(new Response(JSON.stringify(data, null, 2), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } })); }
function errorResponse(code, message, status) { return json({ ok: false, error: { code: ERROR_CODES.has(code) ? code : "INTERNAL_ERROR", message } }, status); }
function cors(response) { const headers = new Headers(response.headers); headers.set("Access-Control-Allow-Origin", "*"); headers.set("Access-Control-Allow-Methods", "GET, OPTIONS"); headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization"); return new Response(response.body, { status: response.status, statusText: response.statusText, headers }); }
