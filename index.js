/**
 * EGYFILM APOLLO - Vercel Edge Function v2 (Pro)
 * High-performance, Token-protected, Proxy-enabled Stream Relay
 */

export const config = {
  runtime: 'edge', // تشغيل البيئة كـ Edge Function على فيرسل
};

const CONFIG_JSON_URL = "https://egyfilm.xyz/stream/data.json";
const PROXY_SCRIPT_URL = "https://egyfilm.xyz/stream/proxy.php?url=";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Content-Type, Origin, Accept",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
  "Cross-Origin-Resource-Policy": "cross-origin"
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

function safeUrl(raw) {
  try { return new URL(String(raw || "").trim()); } catch (_) { return null; }
}

async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

const WORKER_CONFIG_URL = CONFIG_JSON_URL.replace('data.json', 'api.php?action=worker_config');

function mergeHeaders(...list) {
  const out = { referer: "", origin: "", user_agent: "" };
  for (const h of list) {
    if (!h) continue;
    if (h.referer) out.referer = h.referer;
    if (h.origin) out.origin = h.origin;
    if (h.user_agent) out.user_agent = h.user_agent;
  }
  return out;
}

function effectiveHeaders(config, channelKey, section) {
  const settings = (config && config.settings) || {};
  const ch = (config.channels && config.channels[channelKey]) || {};
  const sec = (section && config.sections && config.sections[section]) || {};
  return mergeHeaders(settings.headers, sec.headers, ch.headers);
}

function effectiveThief(config, channelKey, section) {
  const settings = (config && config.settings) || {};
  const ch = (config.channels && config.channels[channelKey]) || {};
  if (ch.thief !== undefined) return !!ch.thief;
  const sec = (section && config.sections && config.sections[section]) || {};
  if (sec.thief !== undefined) return !!sec.thief;
  return !!(settings.thief_all);
}

function hostOf(u) {
  try { return new URL(String(u)).hostname.toLowerCase(); } catch (e) { return String(u).toLowerCase(); }
}

function headerMatches(actual, expected) {
  if (actual === expected) return true;
  const a = hostOf(actual), e = hostOf(expected);
  return !!(a && e && a === e);
}

function hasConfiguredHeaders(headersCfg) {
  return !!(headersCfg && (headersCfg.referer || headersCfg.origin || headersCfg.user_agent));
}

// الكود المعدل لمعالجة الهيدرات بذكاء لملفات الفيديو TS و m3u8
function validateThiefHeaders(request, headersCfg, requestUrl, isManifestRequest) {
  const get = (k) => {
    let val = request.headers.get(k);
    return val === "null" ? null : val;
  };
  
  const selfHost = requestUrl.hostname.toLowerCase();

  // فحص الريفير
  if (headersCfg.referer) {
    const ref = get("referer");
    if (!ref) {
      // إذا كان الطلب للملف الأساسي ولا يوجد ريفير، امنعه. 
      // أما قطع الفيديو (ts) فنتجاوزها لأن المشغلات تخفي الريفير منها أحياناً
      if (isManifestRequest) return false;
    } else {
      const refHost = hostOf(ref);
      const expectedHost = hostOf(headersCfg.referer);
      // نسمح للطلب لو طابق موقعك، أو لو طابق الدومين الخاص بالوركر نفسه (تحدث في السفاري)
      if (refHost !== expectedHost && refHost !== selfHost) {
        return false;
      }
    }
  }

  // فحص الأوريجين
  if (headersCfg.origin) {
    const origin = get("origin");
    if (origin) {
      const originHost = hostOf(origin);
      const expectedHost = hostOf(headersCfg.origin);
      if (originHost !== expectedHost && originHost !== selfHost) {
        return false;
      }
    }
  }

  // فحص اليوزر أجنت (ثابت دائماً في كل الطلبات)
  if (headersCfg.user_agent) {
    if (get("user-agent") !== headersCfg.user_agent) return false;
  }

  return true;
}

function buildThiefRedirect(thiefUrl, requestUrl, channelKey, section) {
  const tpl = String(thiefUrl || "").trim();
  if (!tpl) return "";
  const safe = new URL(requestUrl.toString());
  safe.searchParams.delete("hdnts");
  safe.searchParams.delete("token");
  let t = tpl;
  if (t.includes("{url}")) {
    t = t.replace(/\{url\}/g, safe.toString());
  } else if (/^https?:\/\//i.test(t)) {
    t = t + (t.includes("?") ? "&" : "?") + "url=" + encodeURIComponent(safe.toString());
  }
  return t.replace(/\{key\}/g, channelKey).replace(/\{channel\}/g, channelKey).replace(/\{section\}/g, section || "");
}

let cachedConfigData = null;
let lastConfigFetchTime = 0;

async function loadConfig() {
  const now = Date.now();
  if (cachedConfigData && (now - lastConfigFetchTime < 60000)) {
      return cachedConfigData;
  }

  let errMsgs = [];
  
  try {
      const res = await fetch(WORKER_CONFIG_URL);
      if (res.ok) {
          const text = await res.text();
          try {
              const parsed = JSON.parse(text);
              cachedConfigData = parsed;
              lastConfigFetchTime = now;
              return parsed;
          } catch(e) { errMsgs.push("api.php JSON parse error"); }
      } else { errMsgs.push("api.php HTTP " + res.status); }
  } catch(e) { errMsgs.push("api.php fetch error: " + e.message); }

  try {
      const res = await fetch(CONFIG_JSON_URL);
      if (res.ok) {
          const text = await res.text();
          try {
              const parsed = JSON.parse(text);
              cachedConfigData = parsed;
              lastConfigFetchTime = now;
              return parsed;
          } catch(e) { errMsgs.push("data.json JSON parse error (might be encrypted)"); }
      } else { errMsgs.push("data.json HTTP " + res.status); }
  } catch(e) { errMsgs.push("data.json fetch error: " + e.message); }
  
  if (cachedConfigData) return cachedConfigData;
  
  throw new Error(errMsgs.join(" | "));
}

function detectStreamType(channelData, originUrl) {
  const provided = String(channelData.stream_type || "").toLowerCase().trim();
  if (provided === "mpd" || provided === "m3u8") return provided;
  const path = originUrl?.pathname || "";
  if (/\.m3u8$/i.test(path) || /\.txt$/i.test(path)) return "m3u8";
  return "mpd";
}

function buildOriginInfo(rawOrigin, streamType) {
  const originUrl = safeUrl(rawOrigin);
  if (!originUrl) throw new Error("Invalid origin URL");
  
  originUrl.hash = "";
  const originalSearch = originUrl.search || "";
  const path = originUrl.pathname || "";
  
  const hasManifestFile = /\.(mpd|m3u8|txt)$/i.test(path);

  let manifestUrl, baseDirUrl;

  if (hasManifestFile) {
    manifestUrl = new URL(originUrl.toString());
    baseDirUrl = new URL(originUrl.toString());
    baseDirUrl.search = "";
    baseDirUrl.pathname = baseDirUrl.pathname.replace(/\/[^/]*$/i, "/");
  } else {
    const base = new URL(originUrl.toString());
    base.search = "";
    base.pathname = base.pathname.replace(/\/+$/g, "") + "/";
    baseDirUrl = new URL(base.toString());
    manifestUrl = new URL(base.toString());
    manifestUrl.pathname = manifestUrl.pathname + "index." + streamType;
    manifestUrl.search = originalSearch;
  }
  return { manifestUrl, baseDirUrl, defaultSearch: originalSearch };
}

function isDefaultManifestRequest(fileName, streamType) {
  const lower = String(fileName || "").toLowerCase();
  return (
    lower === "" || lower === "index.mpd" || lower === "index.m3u8" ||
    lower === "manifest.mpd" || lower === "playlist.m3u8" ||
    lower === "index." + streamType
  );
}

function buildUpstreamUrl(fileName, requestUrl, originInfo, streamType) {
  const isManifestRequest = isDefaultManifestRequest(fileName, streamType);
  let upstream;
  
  const safeParams = new URLSearchParams(requestUrl.search);
  safeParams.delete('hdnts');
  safeParams.delete('token');
  safeParams.delete('url'); 
  
  const safeSearch = safeParams.toString() ? '?' + safeParams.toString() : '';

  if (isManifestRequest) {
    upstream = new URL(originInfo.manifestUrl.toString());
    if (safeSearch) {
        upstream.search = safeSearch;
    } else if (originInfo.defaultSearch) {
        upstream.search = originInfo.defaultSearch;
    }
  } else {
    upstream = new URL(fileName, originInfo.baseDirUrl);
    if (safeSearch) {
        upstream.search = safeSearch;
    } else if (originInfo.defaultSearch) {
        upstream.search = originInfo.defaultSearch;
    }
  }
  return upstream;
}

function stripTrailingSlash(str) { return String(str || "").replace(/\/+$/g, ""); }

function rewriteManifest(body, originInfo, publicBase, requestUrl, channelData, settings) {
  if (!body) return body;
  const cleanPublicBase = stripTrailingSlash(publicBase);

  const manifestUrl = new URL(originInfo.manifestUrl.toString());
  manifestUrl.search = ""; manifestUrl.hash = "";
  
  const baseDir = new URL(originInfo.baseDirUrl.toString());
  baseDir.search = ""; baseDir.hash = "";

  const replacements = [
    stripTrailingSlash(manifestUrl.toString()),
    stripTrailingSlash(baseDir.toString()),
    stripTrailingSlash(baseDir.origin)
  ].filter(Boolean);
  
  for (const item of replacements) {
    body = body.split(item).join(cleanPublicBase);
  }
  
  const allowedQualities = channelData?.qualities || [];
  const allowedAudios = channelData?.audios || [];
  
  const qsParam = requestUrl.searchParams.has('hdnts') ? 'hdnts=' : 'token=';
  const qsValue = requestUrl.searchParams.has('hdnts') ? requestUrl.searchParams.get('hdnts') : requestUrl.searchParams.get('token');
  const tokenQs = qsValue ? qsParam + qsValue : '';
  const qsPrefix = tokenQs ? '?' + tokenQs : '';

  if (body.includes('#EXTM3U')) {
    const lines = body.split('\n');
    const out = [];
    let skipNext = false;
    for (let i=0; i<lines.length; i++) {
        let line = lines[i].trim();
        
        if (skipNext) {
            skipNext = false;
            continue;
        }
        if (line.startsWith('#EXT-X-MEDIA:TYPE=AUDIO') && allowedAudios.length > 0) {
            const m = line.match(/NAME="([^"]+)"/);
            if (m && m[1] && !allowedAudios.includes(m[1])) continue;
        }
        if (line.startsWith('#EXT-X-STREAM-INF') && allowedQualities.length > 0) {
            const m = line.match(/RESOLUTION=\d+x(\d+)/);
            if (m && m[1] && !allowedQualities.includes(m[1].toString())) {
                skipNext = true;
                continue;
            }
        }
        
        if (line && !line.startsWith('#') && !line.startsWith('http')) {
            out.push(cleanPublicBase + '/' + line + qsPrefix);
        } else if (line.startsWith('http') && line.includes(cleanPublicBase)) {
            if (!line.includes('?')) out.push(line + qsPrefix);
            else out.push(line);
        } else if (line.startsWith('http')) {
            const encodedUrl = btoa(line);
            const sep = qsPrefix ? '&' + tokenQs : '';
            out.push(cleanPublicBase + '/PROXY_SEGMENT?url=' + encodedUrl + sep);
        } else {
            out.push(line);
        }
    }
    body = out.join('\n');
  } else if (body.includes('<MPD')) {
      if (settings && settings.dev_info) {
          body = body.replace(/(<MPD[^>]*>)/i, '$1\n' + settings.dev_info + '\n');
      }
      body = body.replace(/<BaseURL>.*?<\/BaseURL>/ig, '');
      if (channelData && channelData.mpd_title) {
          if (body.match(/<Title>/i)) {
              body = body.replace(/<Title>[\s\S]*?<\/Title>/ig, '<Title>' + channelData.mpd_title + '</Title>');
          } else if (body.match(/<ProgramInformation>/i)) {
              body = body.replace(/(<ProgramInformation[^>]*>)/i, '$1\n    <Title>' + channelData.mpd_title + '</Title>');
          }
      }
      if (allowedAudios.length > 0) {
          body = body.replace(/<AdaptationSet\b[^>]*lang=["']([^"']+)["'][^>]*(?:\/>|>[\s\S]*?<\/AdaptationSet>)/gi, (match, lang) => {
              return allowedAudios.includes(lang.toString()) ? match : '';
          });
      }
      if (allowedQualities.length > 0) {
          body = body.replace(/<Representation\b[^>]*height=["'](\d+)["'][^>]*(?:\/>|>[\s\S]*?<\/Representation>)/gi, (match, height) => {
              return allowedQualities.includes(height.toString()) ? match : '';
          });
      }
      if (tokenQs) {
          body = body.replace(/(media|initialization)="([^"]+\.(m4s|mp4|ts))"/ig, '$1="$2?' + tokenQs + '"');
      }
      body = body.replace(/^[ \t]*[\r\n]+/gm, '');
  }

  return body;
}

export default async function handler(request) {
  const requestUrl = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (requestUrl.pathname === "/health") {
    return new Response("OK", { status: 200, headers: CORS_HEADERS });
  }

  let config;
  try {
    config = await loadConfig();
  } catch (e) {
    return jsonResponse({ success: false, error: "Cannot load config", details: e.message }, 502);
  }

  const parts = requestUrl.pathname.split("/").filter(Boolean);
  if (!parts.length) return jsonResponse({ success: false, error: "Missing channel key" }, 400);

  let section = "";
  let channelKey = parts[0];
  if (parts.length >= 2 && config.sections && config.sections[parts[0]]) {
    section = parts[0];
    channelKey = parts[1];
  }

  if (!channelKey) return jsonResponse({ success: false, error: "Missing channel key" }, 400);
  if (!config.channels || !config.channels[channelKey]) return jsonResponse({ success: false, error: "Channel not found" }, 404);

  const effSection = section || (config.channels[channelKey].section || "");
  const channelData = config.channels[channelKey];
  if (channelData.active === false) return jsonResponse({ success: false, error: "Channel disabled" }, 403);

  const settings = config.settings || {};
  const streamHeaders = effectiveHeaders(config, channelKey, effSection);
  const thief = effectiveThief(config, channelKey, effSection);

  // تحديد مسار واسم الملف للتحقق مما إذا كان مانيفيست أو قطعة فيديو
  const rawOrigin = String(channelData.origin || "").trim();
  if (!rawOrigin) return jsonResponse({ success: false, error: "Channel origin empty" }, 500);

  const originUrlForDetect = safeUrl(rawOrigin);
  const streamType = detectStreamType(channelData, originUrlForDetect);
  let requestedParts = parts.slice(section ? 2 : 1).join('/');
  const fileName = requestedParts || "index." + streamType;
  const isManifestRequest = fileName.toLowerCase().endsWith(".mpd") || fileName.toLowerCase().endsWith(".m3u8") || isDefaultManifestRequest(fileName, streamType);

  // التحقق من الحرامي والهيدرات باستخدام الكود الذكي المحدث
  if ((thief || hasConfiguredHeaders(streamHeaders)) && !validateThiefHeaders(request, streamHeaders, requestUrl, isManifestRequest)) {
    const decoy = buildThiefRedirect(settings.thief_url, requestUrl, channelKey, effSection);
    if (decoy) return Response.redirect(decoy, 302);
    return jsonResponse({ success: false, error: "Forbidden: headers required" }, 403);
  }

  // Token Validation
  const isProtected = settings.token_protection_enabled && (channelData.protected !== false);
  
  if (isProtected) {
      const bypassHeader = request.headers.get('x-bypass-token');        
      if (bypassHeader) {
          const expectedBypass = await sha256(channelKey + settings.token_secret);
          if (bypassHeader !== expectedBypass) {
              return jsonResponse({ success: false, error: "Invalid bypass token" }, 403);
          }
      } else {
          const tokenParam = requestUrl.searchParams.get('hdnts') || requestUrl.searchParams.get('token');
          if (!tokenParam) {
              return jsonResponse({ success: false, error: "Token missing" }, 403);
          }
          
          const partsToken = tokenParam.split('~');
          let exp = 0;
          let hmac = '';
          for (const p of partsToken) {
              if (p.startsWith('exp=')) exp = parseInt(p.substring(4));
              if (p.startsWith('hmac=')) hmac = p.substring(5);
          }
          
          const now = Math.floor(Date.now() / 1000);
          if (!exp || !hmac || now > exp) {
              return jsonResponse({ success: false, error: "Token expired or invalid" }, 403);
          }
          
          const expectedHash = await sha256(channelKey + exp.toString() + settings.token_secret);
          const expectedToken = expectedHash.substring(0, 16);
          
          if (hmac !== expectedToken) {
              return jsonResponse({ success: false, error: "Invalid token signature" }, 403);
          }
      }
  }

  let originInfo;
  try {
    originInfo = buildOriginInfo(rawOrigin, streamType);
  } catch (e) { return jsonResponse({ success: false, error: "Invalid origin URL" }, 500); }

  let upstreamUrl;
  if (fileName.startsWith('PROXY_SEGMENT')) {
      const targetUrlRaw = requestUrl.searchParams.get('url');
      if (targetUrlRaw) {
          try {
              upstreamUrl = new URL(atob(targetUrlRaw));
          } catch (e) {
              return jsonResponse({ success: false, error: "Invalid proxy url" }, 400);
          }
      } else {
          return jsonResponse({ success: false, error: "Missing proxy url" }, 400);
      }
  } else {
      upstreamUrl = buildUpstreamUrl(fileName, requestUrl, originInfo, streamType);
  }
  
  let finalFetchUrl = upstreamUrl.toString();

  if (channelData.proxy) {
      const hdrs = btoa(JSON.stringify({ user_agent: streamHeaders.user_agent || "" }));
      finalFetchUrl = PROXY_SCRIPT_URL + btoa(finalFetchUrl) + "&hdrs=" + hdrs;
  }

  const upstreamHeaders = new Headers();
  if (request.headers.get("Range")) upstreamHeaders.set("Range", request.headers.get("Range"));
  if (request.headers.get("Accept")) upstreamHeaders.set("Accept", request.headers.get("Accept"));
  if (streamHeaders.user_agent) upstreamHeaders.set("User-Agent", streamHeaders.user_agent);

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(finalFetchUrl, {
      method: request.method,
      headers: upstreamHeaders
    });
  } catch (e) {
    return jsonResponse({ success: false, error: "Upstream fetch failed", details: e.message }, 502);
  }

  const responseHeaders = new Headers(upstreamResponse.headers);
  Object.entries(CORS_HEADERS).forEach(([key, value]) => responseHeaders.set(key, value));
  
  responseHeaders.delete("set-cookie");
  responseHeaders.delete("expires");
  responseHeaders.delete("pragma");
  responseHeaders.delete("cache-control");

  if (!upstreamResponse.ok) {
      return new Response("Upstream Error: " + upstreamResponse.status, { status: upstreamResponse.status, headers: responseHeaders });
  }

  let finalResponse;

  if (isManifestRequest) {
    let contentType = streamType === 'm3u8' ? "application/vnd.apple.mpegurl" : "application/dash+xml";
    responseHeaders.set("Content-Type", contentType + "; charset=utf-8");
    responseHeaders.set("Cache-Control", "public, s-maxage=2, max-age=2");
    
    if (request.method === "HEAD") {
      finalResponse = new Response(null, { status: upstreamResponse.status, headers: responseHeaders });
    } else {
      let body = await upstreamResponse.text();
      const publicBase = requestUrl.origin + "/" + (section ? encodeURIComponent(section) + "/" : "") + encodeURIComponent(channelKey);
      
      body = rewriteManifest(body, originInfo, publicBase, requestUrl, channelData, config.settings);

      finalResponse = new Response(body, { status: upstreamResponse.status, headers: responseHeaders });
    }
  } else {
    responseHeaders.set("Cache-Control", "public, s-maxage=31536000, max-age=31536000, immutable");
    finalResponse = new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: responseHeaders
    });
  }

  return finalResponse;
}
