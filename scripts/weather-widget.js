/** Weather - Egern generic widget - v1.0.0
 * Standalone ES module with no runtime dependencies. Set REGION to get started.
 * Two fixed storage keys, limited to 4 KiB total. Tickets remain in memory.
 */
const H5 = 'https://h5.caiyunapp.com';
const GEO_URL = 'https://starplucker.cyapi.cn/v3/geo/geocode';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  Origin: H5, Referer: `${H5}/`,
};
const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const STALE_LIMIT = 6 * HOUR;
const SNAPSHOT_VERSION = 4, FORECAST_DAYS = 5;
// Keep storage keys stable and version their contents to avoid orphaned records.
export const CACHE_KEYS = Object.freeze({ geo: 'egern.weather.geo.v1', weather: 'egern.weather.snapshot.v1' });
const LIMITS = { geo: 768, weather: 3328 }; // UTF-8 byte limits, including key names.
const finite = n => typeof n === 'number' && Number.isFinite(n);
const numeric = n => (typeof n === 'number' || typeof n === 'string' && n.trim() !== '') && finite(Number(n)) ? Number(n) : null;
const short = (s, n) => Array.from(typeof s === 'string' ? s : '').slice(0, n).join('');
const codeOf = s => typeof s === 'string' && /^[A-Z_]{1,32}$/.test(s) ? s : 'UNKNOWN';
const needsCloud = code => ['LIGHT_RAIN', 'MODERATE_RAIN'].includes(code);
const cloudValue = value => {
  const n = numeric(value);
  return n !== null && n >= 0 && n <= 1 ? Math.round(n * 100) / 100 : null;
};
const onlyKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));
const ageWithin = (at, duration, now) => finite(at) && at <= now && now - at < duration;
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && finite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
const nextDate = (date, offset) => new Date(Date.parse(`${date}T12:00:00Z`) + offset * DAY).toISOString().slice(0, 10);
export const temperatureText = n => finite(n) ? `${Math.round(n) || 0}°` : '—';

class WeatherError extends Error {
  constructor(message, auth = false) { super(message); this.auth = auth; }
}

export function settings(env = {}) {
  env = env || {};
  const region = String(env.REGION || '').trim();
  const minutes = Number(env.REFRESH_MINUTES);
  return { region, title: short(String(env.TITLE || '').trim(), 80),
    refreshMinutes: [15, 30, 60].includes(minutes) ? minutes : 30 };
}

export function utf8Bytes(s) {
  let bytes = 0;
  for (const c of s) {
    const cp = c.codePointAt(0);
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}
function remove(ctx, kind) {
  try { ctx.storage?.delete(CACHE_KEYS[kind]); } catch (_) { /* Storage errors must not block rendering. */ }
}
function read(ctx, kind, region) {
  try {
    const raw = ctx.storage?.get ? ctx.storage.get(CACHE_KEYS[kind])
      : JSON.stringify(ctx.storage?.getJSON(CACHE_KEYS[kind]) ?? null);
    if (!raw) return null;
    if (typeof raw !== 'string' || utf8Bytes(raw) + utf8Bytes(CACHE_KEYS[kind]) > LIMITS[kind]) throw Error();
    const value = JSON.parse(raw);
    if (value === null) return null;
    if (!(kind === 'weather' ? [1, 2, 3, SNAPSHOT_VERSION].includes(value.version) : value.version === 1) || value.region !== region) throw Error();
    return value;
  } catch (_) { remove(ctx, kind); return null; }
}
function write(ctx, kind, value) {
  try {
    const raw = JSON.stringify(value);
    if (utf8Bytes(CACHE_KEYS[kind]) + utf8Bytes(raw) > LIMITS[kind]) { remove(ctx, kind); return; }
    if (ctx.storage?.set) ctx.storage.set(CACHE_KEYS[kind], raw);
    else ctx.storage?.setJSON(CACHE_KEYS[kind], value);
  } catch (_) { /* The current network result can still be displayed. */ }
}
function validGeo(g) {
  return onlyKeys(g, ['version', 'region', 'name', 'lon', 'lat', 'at']) && finite(g.at) && finite(g.lon) && Math.abs(g.lon) <= 180
    && finite(g.lat) && Math.abs(g.lat) <= 90 && typeof g.name === 'string';
}
function validSnapshot(s, now) {
  if (!onlyKeys(s, ['version', 'region', 'fetchedAt', 'sourceAt', 'timezone', 'shift', 'current', 'hours', 'days', 'today', 'astro', 'notice', 'failures', 'retryAt'])
    || !Number.isInteger(s.failures) || s.failures < 0 || s.failures > 3
    || !finite(s.retryAt) || s.retryAt < 0 || s.retryAt > now + 30 * MINUTE) return false;
  if (s.fetchedAt === undefined) return s.failures > 0 && onlyKeys(s, ['version', 'region', 'failures', 'retryAt']);
  const nullable = n => n === null || finite(n);
  const validCloud = h => h.cloud === undefined || needsCloud(h.code) && finite(h.cloud) && h.cloud >= 0 && h.cloud <= 1;
  return finite(s.fetchedAt) && s.fetchedAt <= now && nullable(s.sourceAt)
    && typeof s.timezone === 'string' && finite(s.shift) && Math.abs(s.shift) <= 86400
    && onlyKeys(s.current, ['temperature', 'code', 'cloud']) && finite(s.current?.temperature) && typeof s.current?.code === 'string' && validCloud(s.current)
    && Array.isArray(s.hours) && s.hours.length <= 7
    && s.hours.every(h => onlyKeys(h, ['at', 'temperature', 'code', 'cloud']) && finite(h.at) && nullable(h.temperature) && typeof h.code === 'string' && validCloud(h))
    && (s.notice === undefined || onlyKeys(s.notice, ['text', 'until']) && typeof s.notice.text === 'string'
      && Array.from(s.notice.text).length <= 48 && finite(s.notice.until) && s.notice.until > s.fetchedAt && s.notice.until <= s.fetchedAt + 15 * MINUTE)
    // Accept legacy daily ranges; new snapshots store five days starting tomorrow.
    && Array.isArray(s.days) && s.days.length <= FORECAST_DAYS
    && s.days.every(d => onlyKeys(d, ['date', 'low', 'high', 'code']) && isDate(d.date) && nullable(d.low) && nullable(d.high) && typeof d.code === 'string')
    && (s.today === undefined || s.today === null || onlyKeys(s.today, ['date', 'low', 'high']) && isDate(s.today.date)
      && nullable(s.today.low) && nullable(s.today.high) && (finite(s.today.low) || finite(s.today.high))
      && (s.today.low === null || s.today.high === null || s.today.low <= s.today.high))
    && Array.isArray(s.astro) && s.astro.length <= 2
    && s.astro.every(a => onlyKeys(a, ['date', 'rise', 'set']) && isDate(a.date) && nullable(a.rise) && nullable(a.set));
}
function failureState(region, old, now) {
  const failures = Math.min(3, (old?.failures || 0) + 1);
  const base = old?.current && ageWithin(old.fetchedAt, STALE_LIMIT, now) ? prune(old, now) : { version: 1, region };
  return { ...base, version: SNAPSHOT_VERSION, failures, retryAt: now + [5, 15, 30][failures - 1] * MINUTE };
}

// ---------- Network: shared deadlines; never log URLs containing tickets ----------
async function request(ctx, url, post, body, deadline, clock) {
  const remaining = deadline - clock();
  if (remaining <= 0) throw new WeatherError('天气请求超时');
  const options = { headers: { ...HEADERS }, timeout: Math.min(7000, remaining) };
  if (post) options.body = body === undefined ? '' : JSON.stringify(body);
  if (body !== undefined) options.headers['Content-Type'] = 'application/json';
  let response;
  try { response = await ctx.http[post ? 'post' : 'get'](url, options); }
  catch (_) { throw new WeatherError('网络连接失败'); }
  if (clock() >= deadline) throw new WeatherError('天气请求超时');
  const status = Number(response.status);
  if (status === 401 || status === 403) throw new WeatherError('临时认证失败', true);
  if (!finite(status) || status < 200 || status >= 300) throw new WeatherError('天气服务暂不可用');
  let data;
  try { data = await response.json(); } catch (_) { throw new WeatherError('服务未返回有效数据'); }
  if (clock() >= deadline) throw new WeatherError('天气请求超时');
  if (!data || typeof data !== 'object') throw new WeatherError('天气数据格式异常');
  if ([401, 403].includes(Number(data.statusCode))
    || /invalid ticket|ticket expired|expired ticket|auth failed|unauthorized/i.test(String(data.message || data.error || ''))) {
    throw new WeatherError('临时认证已失效', true);
  }
  return data;
}
async function coordinates(ctx, config, cached, deadline, clock) {
  if (validGeo(cached) && ageWithin(cached.at, 30 * DAY, clock())) return cached;
  const data = await request(ctx, `${GEO_URL}?query=${encodeURIComponent(config.region)}&limit=1&lang=zh_CN`, false, undefined, deadline, clock);
  const p = data.items?.[0];
  const geo = { version: 1, region: config.region, name: short(p?.name, 80) || short(config.region, 80),
    lon: numeric(p?.longitude), lat: numeric(p?.latitude), at: clock() };
  if (!validGeo(geo)) throw new WeatherError('未找到地区，请填写完整市区名');
  write(ctx, 'geo', geo);
  return geo;
}
async function ticket(ctx, deadline, clock) {
  const data = await request(ctx, `${H5}/api/ticket`, true, undefined, deadline, clock);
  if (typeof data.ticket !== 'string' || !data.ticket.trim()) throw new WeatherError('未获得临时认证');
  return data.ticket;
}
async function fetchWeather(ctx, geo, deadline, clock) {
  let token = await ticket(ctx, deadline, clock);
  const upstream = `https://api.caiyunapp.com/v2.5/<t2.5>/${geo.lon},${geo.lat}/weather?dailysteps=16&hourlysteps=120&alert=true&begin=${Math.floor(clock() / 1000) - 86400}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await request(ctx, `${H5}/api/?ticket=${encodeURIComponent(token)}`, true, { url: upstream }, deadline, clock); }
    catch (error) {
      if (!error.auth || attempt === 1 || deadline - clock() <= 0) throw error;
      token = await ticket(ctx, deadline, clock);
    }
  }
}

// ---------- Normalize only the data needed for display ----------
export function localParts(ms, meta) {
  try {
    if (meta.timezone && typeof Intl !== 'undefined') {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: meta.timezone, year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
      const p = Object.fromEntries(parts.map(v => [v.type, v.value]));
      return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second) };
    }
  } catch (_) { /* Fall back to the server offset when JSCore cannot resolve the time zone. */ }
  const d = new Date(ms + meta.shift * 1000);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() };
}
function hourFloor(now, meta) {
  const p = localParts(now, meta);
  return now - (p.minute * 60 + p.second) * 1000 - ((now % 1000) + 1000) % 1000;
}
function rows(values, field, hourly) {
  const map = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value?.[field] !== 'string') continue;
    const key = hourly ? Date.parse(value[field]) : value[field].slice(0, 10);
    if (hourly ? finite(key) : isDate(key)) map.set(key, value);
  }
  return map;
}
function minutes(value) {
  if (!/^\d{2}:\d{2}$/.test(value || '')) return null;
  const [h, m] = value.split(':').map(Number);
  return h < 24 && m < 60 ? h * 60 + m : null;
}
function dailyTemperatures(value) {
  let low = numeric(value?.min), high = numeric(value?.max);
  if (low !== null && high !== null && low > high) low = high = null;
  return { low, high };
}
function todayTemperatures(s, date) {
  // Reuse today from legacy snapshots; the entry point refreshes incomplete records.
  const d = s.today?.date === date ? s.today : s.days.find(d => d.date === date);
  return finite(d?.low) || finite(d?.high) ? { date, low: d.low ?? null, high: d.high ?? null } : null;
}
export function normalizeWeather(data, region, now) {
  const r = data?.result, current = r?.realtime;
  if (data?.status !== 'ok' || current?.status !== 'ok' || numeric(current.temperature) === null) {
    throw new WeatherError('当前天气暂不可用');
  }
  const shift = numeric(data.tzshift);
  const snapshot = { version: SNAPSHOT_VERSION, region, fetchedAt: now, sourceAt: numeric(data.server_time),
    timezone: short(data.timezone, 64), shift: shift !== null && Math.abs(shift) <= 86400 ? shift : 28800,
    current: { temperature: numeric(current.temperature), code: codeOf(current.skycon) },
    // Null means the range was requested but unavailable; an absent field marks legacy data.
    hours: [], days: [], today: null, astro: [], failures: 0, retryAt: 0 };
  const today = localParts(now, snapshot).date;
  const currentCloud = cloudValue(current.cloudrate);
  if (needsCloud(snapshot.current.code) && currentCloud !== null) snapshot.current.cloud = currentCloud;
  const daily = r.daily?.status === 'ok' ? r.daily : {};
  const hourly = r.hourly?.status === 'ok' ? r.hourly : {};
  const ht = rows(hourly.temperature, 'datetime', true), hs = rows(hourly.skycon, 'datetime', true);
  const hc = rows(hourly.cloudrate, 'datetime', true);
  const floor = hourFloor(now, snapshot);
  // Keep six future hours plus one spare to cover the maximum one-hour refresh interval.
  for (let i = 1; i <= 7; i++) {
    const at = floor + i * HOUR;
    if (ht.has(at) || hs.has(at)) {
      const h = { at, temperature: numeric(ht.get(at)?.value), code: codeOf(hs.get(at)?.value) };
      const cloud = cloudValue(hc.get(at)?.value);
      if (needsCloud(h.code) && cloud !== null) h.cloud = cloud;
      snapshot.hours.push(h);
    }
  }
  const dt = rows(daily.temperature, 'date', false), ds = rows(daily.skycon, 'date', false), da = rows(daily.astro, 'date', false);
  const range = dailyTemperatures(dt.get(today));
  if (range.low !== null || range.high !== null) snapshot.today = { date: today, ...range };
  for (let i = 1; i <= FORECAST_DAYS; i++) {
    const date = nextDate(today, i);
    if (dt.has(date) || ds.has(date)) {
      const { low, high } = dailyTemperatures(dt.get(date));
      snapshot.days.push({ date, low, high, code: codeOf(ds.get(date)?.value) });
    }
  }
  // Keep astronomy for today and tomorrow independently of the daily temperature range.
  for (let i = 0; i < 2; i++) {
    const date = nextDate(today, i);
    if (da.has(date)) {
      const a = da.get(date);
      snapshot.astro.push({ date, rise: minutes(a?.sunrise?.time), set: minutes(a?.sunset?.time) });
    }
  }
  const minute = r.minutely;
  const description = typeof minute?.description === 'string' ? minute.description.replace(/[\r\n\t]/g, ' ').trim() : '';
  // Keep a short notice only when precipitation is forecast; expire it after 15 minutes.
  if (minute?.status === 'ok' && description && Array.from(description).length <= 48
    && Array.isArray(minute.precipitation) && minute.precipitation.some(n => finite(n) && n > 0)) {
    snapshot.notice = { text: description, until: now + 15 * MINUTE };
  }
  return snapshot;
}
function prune(s, now) {
  const date = localParts(now, s).date, range = todayTemperatures(s, date);
  const { today, notice, ...rest } = s;
  return { ...rest, ...(notice?.until > now ? { notice } : {}), today: range, hours: s.hours.filter(h => h.at > now),
    days: s.days.filter(d => d.date > date), astro: s.astro.filter(a => a.date >= date) };
}
function daytime(at, snapshot, code) {
  const p = localParts(at, snapshot), a = snapshot.astro.find(a => a.date === p.date);
  if (finite(a?.rise) && finite(a?.set) && a.rise < a.set) return p.hour * 60 + p.minute >= a.rise && p.hour * 60 + p.minute < a.set;
  if (code.endsWith('_NIGHT')) return false;
  if (code.endsWith('_DAY')) return true;
  return p.hour >= 6 && p.hour < 18;
}
export function condition(code) {
  const known = {
    CLEAR_DAY: ['晴', 'clear'], CLEAR_NIGHT: ['晴', 'clear'], PARTLY_CLOUDY_DAY: ['多云', 'partly'], PARTLY_CLOUDY_NIGHT: ['多云', 'partly'], CLOUDY: ['阴', 'cloud'],
    LIGHT_RAIN: ['小雨', 'rain'], MODERATE_RAIN: ['中雨', 'rain'], HEAVY_RAIN: ['大雨', 'rain'], STORM_RAIN: ['暴雨', 'rain'], RAIN: ['雨', 'rain'],
    LIGHT_SNOW: ['小雪', 'snow'], MODERATE_SNOW: ['中雪', 'snow'], HEAVY_SNOW: ['大雪', 'snow'], STORM_SNOW: ['暴雪', 'snow'], SNOW: ['雪', 'snow'],
    SLEET: ['雨夹雪', 'mixed'], RAIN_SNOW: ['雨夹雪', 'mixed'], HAIL: ['冰雹', 'hail'], FREEZING_RAIN: ['冻雨', 'ice'], FREEZING_DRIZZLE: ['冻毛毛雨', 'ice'],
    LIGHT_HAZE: ['轻度雾霾', 'haze'], MODERATE_HAZE: ['中度雾霾', 'haze'], HEAVY_HAZE: ['重度雾霾', 'haze'],
    FOG: ['雾', 'fog'], DUST: ['浮尘', 'haze'], SAND: ['沙尘', 'haze'], WIND: ['大风', 'wind'], THUNDER_SHOWER: ['雷阵雨', 'storm'],
  };
  const [label, kind] = known[code] || ['天气未知', 'unknown'];
  return { label, kind };
}
function localTimeAt(date, minute, meta) {
  if (!isDate(date) || !finite(minute) || minute < 0 || minute >= 1440) return null;
  const wall = Date.parse(`${date}T00:00:00Z`) + minute * MINUTE;
  let at = wall - meta.shift * 1000;
  // Resolve local wall time to a timestamp without assuming a fixed offset across DST.
  for (let i = 0; i < 4; i++) {
    const p = localParts(at, meta);
    const actual = Date.parse(`${p.date}T00:00:00Z`) + (p.hour * 60 + p.minute) * MINUTE + p.second * 1000;
    if (actual === wall) return at;
    at += wall - actual;
  }
  return null;
}
function twilightAt(s, now) {
  const date = localParts(now, s).date, astro = s.astro.find(a => a.date === date);
  if (!astro) return null;
  const sunset = localTimeAt(date, astro.set, s), sunrise = localTimeAt(date, astro.rise, s);
  if (sunset !== null && now >= sunset - 45 * MINUTE && now < sunset + 75 * MINUTE) {
    return { phase: 'dusk', amount: (now - sunset + 45 * MINUTE) / (120 * MINUTE) };
  }
  if (sunrise !== null && now >= sunrise - 45 * MINUTE && now < sunrise + 30 * MINUTE) {
    return { phase: 'dawn', amount: (now - sunrise + 45 * MINUTE) / (75 * MINUTE) };
  }
  return null;
}
function solarTimeline(s, now, hours) {
  const events = [], last = hours.at(-1).at;
  for (const a of s.astro) {
    if (finite(a.rise) && finite(a.set) && a.rise >= a.set) continue;
    for (const [event, minute] of [['sunrise', a.rise], ['sunset', a.set]]) {
      const at = localTimeAt(a.date, minute, s);
      if (at === null || at <= now || at > last) continue;
      const p = localParts(at, s);
      // No minute temperatures are available; show the solar event name instead.
      events.push({ at, event, temperature: null, missing: false,
        label: `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}` });
    }
  }
  const eventTimes = new Set(events.map(e => e.at));
  return [...hours.filter(h => !eventTimes.has(h.at)), ...events].sort((a, b) => a.at - b.at).slice(0, 6);
}
export function viewModel(s, config, geo, now, stale = false) {
  const today = localParts(now, s).date;
  const floor = hourFloor(now, s), byHour = new Map(s.hours.map(h => [h.at, h]));
  const hours = [];
  for (let i = 1; i <= 6; i++) {
    const at = floor + i * HOUR, h = byHour.get(at);
    hours.push({ at, temperature: h?.temperature ?? null, code: h?.code || 'UNKNOWN', cloud: h?.cloud,
      label: `${localParts(at, s).hour}时`, day: daytime(at, s, h?.code || ''), missing: !h });
  }
  const futureDays = Array.from({ length: FORECAST_DAYS }, (_, i) => {
    const date = nextDate(today, i + 1), d = s.days.find(d => d.date === date);
    const label = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(`${date}T12:00:00Z`).getUTCDay()];
    return { date, label, low: d?.low ?? null, high: d?.high ?? null, code: d?.code || 'UNKNOWN', missing: !d };
  });
  const timeline = solarTimeline(s, now, hours);
  const twilight = twilightAt(s, now), notice = !stale && s.notice?.until > now ? s.notice : null;
  const boundaries = s.astro.flatMap(a => [localTimeAt(a.date, a.rise, s), localTimeAt(a.date, a.set, s)])
    .filter(finite).map(at => at - 45 * MINUTE).filter(at => at > now);
  const nextChangeAt = Math.min(floor + HOUR, ...timeline.filter(h => h.event).map(h => h.at), ...boundaries,
    twilight ? (Math.floor(now / (15 * MINUTE)) + 1) * 15 * MINUTE : Infinity, notice?.until ?? Infinity);
  return { title: config.title || geo?.name || config.region, ...s.current, ...condition(s.current.code),
    today: todayTemperatures(s, today), hours: timeline, futureDays, nextChangeAt, notice,
    isDay: daytime(now, s, s.current.code), twilight, stale, fetchedAt: s.fetchedAt };
}

// ---------- Icons: embedded SVG artwork on a shared canvas ----------
function svgData(markup) {
  // Encode ASCII SVG directly for JSCore environments without btoa.
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let encoded = '';
  for (let i = 0; i < markup.length; i += 3) {
    const bits = (markup.charCodeAt(i) << 16) | ((markup.charCodeAt(i + 1) || 0) << 8) | (markup.charCodeAt(i + 2) || 0);
    encoded += abc[(bits >> 18) & 63] + abc[(bits >> 12) & 63]
      + (i + 1 < markup.length ? abc[(bits >> 6) & 63] : '=') + (i + 2 < markup.length ? abc[bits & 63] : '=');
  }
  return `data:image/svg+xml;base64,${encoded}`;
}
const CLOUD = "<path d='M16 35C8 35 5 30 5 23S9 12 15 12C17 2 28-1 36 4C41 7 43 12 43 17C51 15 58 21 58 27C58 32 54 35 48 35Z' fill='#F3F7FC'/>";
const PARTLY_SUN = "<circle cx='49' cy='14' r='8' fill='#FFD330'/><path d='M49 2v2M49 24v3M36 14h3M59 14h3M40 5l2 2M57 22l2 2M58 5l-2 2M42 22l-2 2' fill='none' stroke='#FFD330' stroke-width='2.5' stroke-linecap='round'/>";
function rainStrokes(code) {
  const styles = {
    LIGHT_RAIN: ['M20 42l-2 4M33 40l-2 4M46 42l-2 4', 2.5],
    MODERATE_RAIN: ['M20 40l-3 8M33 40l-3 8M46 40l-3 8', 3],
    HEAVY_RAIN: ['M16 39l-4 12M27 39l-4 12M38 39l-4 12M49 39l-4 12', 3.5],
    STORM_RAIN: ['M13 39l-4 12M21 39l-4 12M29 39l-4 12M37 39l-4 12M45 39l-4 12M53 39l-4 12', 4],
  };
  // Use a generic icon for unclassified rain; do not infer rainfall amounts.
  const [path, width] = styles[code] || ['M21 41l-3 7M33 41l-3 7M45 41l-3 7', 3];
  return `<path d='${path}' fill='none' stroke='#42CAE6' stroke-width='${width}' stroke-linecap='round'/>`;
}
function solarIcon(event, width, height) {
  const arrow = event === 'sunrise' ? 'M32 17V3m-6 6 6-6 6 6' : 'M32 3v14m-6-6 6 6 6-6';
  const src = svgData(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 56'>
<path d='${arrow}' fill='none' stroke='#FFFFFF' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'/>
<path d='M18 44a14 14 0 0 1 28 0Z' fill='#FFD330'/>
<path d='M32 22v3M12 30l3 3M49 33l3-3M6 44h5M53 44h5' fill='none' stroke='#FFD330' stroke-width='3' stroke-linecap='round'/>
<path d='M5 49h54' fill='none' stroke='#FFFFFF' stroke-width='3' stroke-linecap='round'/></svg>`);
  return { type: 'image', src, width, height, resizeMode: 'contain' };
}
const MOON = "<path d='M51 2C38 3 36 18 46 24C51 27 58 25 61 21C50 23 44 10 51 2Z' fill='#F6F5ED'/>";
function snowMarks(code) {
  const points = code === 'LIGHT_SNOW' ? [[23,44],[41,47]] : code === 'HEAVY_SNOW' || code === 'STORM_SNOW'
    ? [[15,43],[27,49],[39,43],[51,49]] : [[20,44],[32,49],[45,44]];
  const marks = points.map(([x,y]) => `<path d='M${x-2} ${y}h4M${x} ${y-2}v4'/>`).join('');
  const wind = code === 'STORM_SNOW' ? "<path d='M8 38h17M34 38h22M5 52h12'/>" : '';
  return `<g fill='none' stroke='#E2F5FF' stroke-width='2.2' stroke-linecap='round'>${marks}${wind}</g>`;
}
export function iconSource(code, day, overview = false, cloud) {
  const { kind } = condition(code);
  let body = CLOUD;
  if (kind === 'clear') body = day
    ? "<circle cx='32' cy='28' r='12' fill='#FFD879'/><path d='M32 5v5M32 46v5M9 28h5M50 28h5M16 12l4 4M44 40l4 4M48 12l-4 4M20 40l-4 4' stroke='#FFD879' stroke-width='3' stroke-linecap='round'/>"
    : "<path d='M39 6C17 5 9 30 24 44C35 54 53 47 57 36C39 42 26 20 39 6Z' fill='#F6F5ED'/>";
  if (kind === 'partly' && !overview) body = (day ? PARTLY_SUN : MOON) + CLOUD;
  if (kind === 'rain') {
    // Show a plain rain cloud when cloud cover is unknown or overcast.
    if (!day && needsCloud(code) && finite(cloud) && cloud <= .8) body = MOON + CLOUD;
    body += rainStrokes(code);
  }
  if (kind === 'snow') body += snowMarks(code);
  if (kind === 'fog') body += "<path d='M9 42h46M15 49h34' fill='none' stroke='#F3F7FC' stroke-width='3' stroke-linecap='round'/>";
  if (kind === 'haze') {
    if (code === 'DUST' || code === 'SAND') {
      const sand = code === 'SAND';
      body = `<g fill='none' stroke='#D8C49B' stroke-width='3' stroke-linecap='round'><path d='M7 20h31q12 0 9-8M12 31h37q10 0 8 7M7 43h25'/>${sand ? "<path d='M17 12h12M37 46h16'/>" : ''}</g>`
        + `<g fill='#D8C49B'><circle cx='13' cy='12' r='2'/><circle cx='43' cy='43' r='2'/><circle cx='24' cy='51' r='2'/>${sand ? "<circle cx='6' cy='32' r='2'/><circle cx='56' cy='20' r='2'/>" : ''}</g>`;
    } else {
      const lines = code === 'HEAVY_HAZE' ? [30,37,44,51] : code === 'MODERATE_HAZE' ? [32,41,50] : [36,46];
      body = `<circle cx='32' cy='21' r='12' fill='${day ? '#EBD5A1' : '#DBDFE7'}'/>`
        + `<g stroke='#D8D4C5' stroke-width='3' stroke-linecap='round'>${lines.map((y,i)=>`<path d='M${i%2 ? 13 : 7} ${y}h${i%2 ? 38 : 50}'/>`).join('')}</g>`;
    }
  }
  if (kind === 'wind') body = "<path d='M6 17h30c14 0 14-13 4-11M6 28h42c14 0 14 15 4 14M12 40h19c10 0 10 11 3 11' fill='none' stroke='#F3F7FC' stroke-width='3' stroke-linecap='round'/>";
  if (kind === 'mixed') body += "<path d='M19 40l-3 9M44 40l-3 9' stroke='#42CAE6' stroke-width='3' stroke-linecap='round'/><path d='M28 46h8M32 42v8' stroke='#E2F5FF' stroke-width='2.4' stroke-linecap='round'/>";
  if (kind === 'ice' || kind === 'hail') body += kind === 'hail'
    ? "<g fill='#E2F5FF'><path d='M18 40l4 5-4 5-4-5ZM33 44l4 5-4 5-4-5ZM48 40l4 5-4 5-4-5Z'/></g>"
    : "<path d='M18 39l-3 7M33 39l-3 7M48 39l-3 7' stroke='#8AE2EF' stroke-width='3' stroke-linecap='round'/><path d='M14 52h35' stroke='#E2F5FF' stroke-width='2.5' stroke-linecap='round'/>";
  if (kind === 'storm') body += "<path d='M15 42l-3 7M53 42l-3 7' fill='none' stroke='#42CAE6' stroke-width='3' stroke-linecap='round'/><path d='M34 33L24 45h8l-4 8 16-16h-10l5-4Z' fill='#FFD879'/>";
  if (kind === 'unknown') body = "<path d='M23 19c0-13 24-13 24 0 0 8-13 7-13 17' fill='none' stroke='#FFFFFF99' stroke-width='4' stroke-linecap='round'/><circle cx='34' cy='46' r='2.5' fill='#FFFFFF99'/>";
  return { src: svgData(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 56'>${body}</svg>`) };
}
export function themeFor(model) {
  const themes = {
    clear: ['#2469A8', '#528DB8', '#88ADBF'], partly: ['#4C779D', '#6E92AD', '#8DA8B8'],
    cloud: ['#7B8998', '#6B7889', '#596A7C'], rain: ['#526A82', '#425970', '#354B63'],
    snow: ['#879BAA', '#758C9E', '#647F94'], fog: ['#87949E', '#74838F', '#627584'],
    haze: ['#7D8995', '#707C89', '#616E7C'], storm: ['#4D5D73', '#394D66', '#293C55'],
    wind: ['#638198', '#54758E', '#42647E'],
  };
  const night = ['clear', 'partly'].includes(model.kind) ? ['#201D31', '#252640', '#2B3552'] : ['#343941', '#2B303A', '#222831'];
  const day = themes[model.kind] || themes.cloud;
  let colors = model.isDay ? day : night;
  if (model.twilight) {
    const mix = (a, b, amount) => '#' + [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - amount)
      + parseInt(b.slice(i, i + 2), 16) * amount).toString(16).padStart(2, '0')).join('');
    const smooth = t => t * t * (3 - 2 * t);
    const t = Math.max(0, Math.min(1, model.twilight.amount));
    const dawn = model.twilight.phase === 'dawn', from = dawn ? night : day, to = dawn ? day : night;
    if (['clear', 'partly'].includes(model.kind)) {
      const middle = dawn ? ['#6B7DAB', '#AA9AB5', '#D5B7A8'] : ['#536C9A', '#9295B4', '#C1A59E'];
      colors = t < .5 ? from.map((c,i)=>mix(c,middle[i],smooth(t*2))) : middle.map((c,i)=>mix(c,to[i],smooth((t-.5)*2)));
    } else colors = from.map((c,i)=>mix(c,to[i],smooth(t)));
  }
  return { type: 'linear', colors, stops: [0, 0.56, 1],
    startPoint: { x: 0.5, y: 0 }, endPoint: { x: 0.5, y: 1 } };
}
function skyBackground(m, family) {
  const [w, h] = family === 'systemSmall' ? [164, 164] : family === 'systemLarge' ? [348, 366] : [348, 164];
  const gradient = themeFor(m);
  const stops = gradient.colors.map((color, i) => `<stop offset='${gradient.stops[i]}' stop-color='${color}'/>`).join('');
  const horizon = '#D9EAF4';
  // Draw a static sky with soft lighting; Egern and iOS control system corners and materials.
  return svgData(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}'>
<defs>
<linearGradient id='sky' x1='0' y1='0' x2='0' y2='1'>${stops}</linearGradient>
<radialGradient id='air'><stop stop-color='#FFFFFF' stop-opacity='0.035'/><stop offset='1' stop-color='#FFFFFF' stop-opacity='0'/></radialGradient>
<radialGradient id='horizon'><stop stop-color='${horizon}' stop-opacity='0.015'/><stop offset='1' stop-color='${horizon}' stop-opacity='0'/></radialGradient>
</defs>
<rect width='${w}' height='${h}' fill='url(#sky)'/>
<ellipse cx='${w * 0.2}' cy='0' rx='${w * 0.9}' ry='${h * 0.8}' fill='url(#air)'/>
<ellipse cx='${w * 0.62}' cy='${h * 1.04}' rx='${w * 0.85}' ry='${h * 0.65}' fill='url(#horizon)'/>
</svg>`);
}
const TEMPERATURE_COLORS = [[-20, '#828CE5'], [0, '#7AC9D9'], [10, '#A8D39B'], [16, '#D0D96B'], [20, '#EBDD40'], [25, '#FFD028'], [30, '#F6A23C'], [40, '#EC6E51']];
export function temperatureColor(value) {
  const t = Math.max(TEMPERATURE_COLORS[0][0], Math.min(TEMPERATURE_COLORS[TEMPERATURE_COLORS.length - 1][0], value));
  const upper = TEMPERATURE_COLORS.findIndex(stop => stop[0] >= t);
  if (upper <= 0) return TEMPERATURE_COLORS[0][1];
  const [a, from] = TEMPERATURE_COLORS[upper - 1], [b, to] = TEMPERATURE_COLORS[upper], amount = (t - a) / (b - a);
  return '#' + [1, 3, 5].map(i => Math.round(parseInt(from.slice(i, i + 2), 16) * (1 - amount)
    + parseInt(to.slice(i, i + 2), 16) * amount).toString(16).padStart(2, '0')).join('');
}
export function temperatureRange(day, days) {
  const valid = d => finite(d?.low) && finite(d?.high) && d.low <= d.high;
  const values = days.filter(valid).flatMap(d => [d.low, d.high]);
  if (!valid(day) || !values.length) return null;
  const min = Math.min(...values), max = Math.max(...values), extent = max - min;
  const span = extent ? Math.max(0.025, (day.high - day.low) / extent) : 0.025;
  const before = extent ? Math.min((day.low - min) / extent, 1 - span) : (1 - span) / 2;
  const points = [day.low, ...TEMPERATURE_COLORS.map(([t]) => t).filter(t => t > day.low && t < day.high), day.high];
  return { before, span, after: Math.max(0, 1 - before - span), colors: points.map(temperatureColor),
    stops: day.low === day.high ? [0, 1] : points.map(t => (t - day.low) / (day.high - day.low)) };
}

// ---------- UI: shared layouts calibrated against device screenshots ----------
const UI = Object.freeze({
  white: '#FFFFFF', secondary: 0.82,
  small: { padding: [7, 16, 7, 16], title: 15, temperature: 42, condition: 12,
    rangeTemperature: 24, rangeLabel: 9 },
  medium: { padding: [0, 16, 0, 16], title: 16, temperature: 44, condition: 14,
    leftWidth: 120, rightWidth: 136, mainIconWidth: 22, mainIconHeight: 18, inlineStatus: true,
    rangeTemperature: 24, rangeLabel: 9, rangeBottom: 4,
    hourLabel: 12, hourTemperature: 14, hourIconWidth: 26, hourIconHeight: 22 },
  large: { padding: 16, title: 17, temperature: 44, condition: 14,
    leftWidth: 124, rightWidth: 136, mainIconWidth: 22, mainIconHeight: 18,
    rangeTemperature: 24, rangeLabel: 9, rangeBottom: 4,
    hourLabel: 12, hourTemperature: 14, hourIconWidth: 26, hourIconHeight: 22 },
});
const lineHeight = size => Math.ceil(size * 1.2);
function profileFor(family, stale) {
  const key = family === 'systemSmall' ? 'small' : family === 'systemLarge' ? 'large' : 'medium';
  const p = { ...UI[key] };
  return p;
}
const text = (value, size = 12, extra = {}) => ({ type: 'text', text: String(value), font: { size, weight: 'regular' },
  textColor: UI.white, textAlign: 'left', maxLines: 1, minScale: 0.55, ...extra });
const row = (children, extra = {}) => ({ type: 'stack', direction: 'row', alignItems: 'center', children, ...extra });
const column = (children, extra = {}) => ({ type: 'stack', direction: 'column', alignItems: 'start', children, ...extra });
const spacer = length => length === undefined ? { type: 'spacer' } : { type: 'spacer', length };
const icon = (code, day, width, height = width, overview = false, cloud) => ({ type: 'image', ...iconSource(code, day, overview, cloud), width, height, resizeMode: 'contain' });
const leading = (node, height) => row([node, spacer()], { height });
const trailing = (node, height) => row([spacer(), node], { height });
const centered = (node, height) => row([spacer(), node, spacer()], { height });
function separator() {
  return row([spacer()], { height: 0.5, backgroundColor: '#FFFFFF26' });
}
function updateLabel(at) {
  return row([text('上次更新', 9, { opacity: 0.8 }), { type: 'date', date: new Date(at).toISOString(), format: 'relative',
    font: { size: 9 }, textColor: '#FFFFFFCC', textAlign: 'left', maxLines: 1, minScale: 0.5 }, spacer()], { gap: 3, height: 12 });
}
function todayRange(m, p, align = 'end') {
  const label = last => column([text('最', p.rangeLabel), text(last, p.rangeLabel)],
    { width: p.rangeLabel, alignItems: 'center' });
  const value = n => text(temperatureText(n), p.rangeTemperature,
    { font: { size: p.rangeTemperature, weight: 'light' }, textAlign: 'right' });
  const values = [label('高'), value(m.today.high), spacer(5), label('低'), value(m.today.low)];
  // Align small widgets left and larger widgets right; scale long values to fit.
  return row(align === 'start' ? [...values, spacer()] : [spacer(), ...values],
    { ...(align === 'end' ? { width: p.rightWidth } : {}), height: lineHeight(p.rangeTemperature), gap: 1 });
}
function currentHeader(m, p) {
  const title = text(m.title, p.title, { font: { size: p.title, weight: 'medium' } });
  const temperature = text(temperatureText(m.temperature), p.temperature, { font: { size: p.temperature, weight: 'light' } });
  const left = column([leading(title, lineHeight(p.title)), leading(temperature, lineHeight(p.temperature))], { width: p.leftWidth });
  const range = m.today ? todayRange(m, p) : null;
  const height = Math.max(lineHeight(p.title) + lineHeight(p.temperature),
    4 + p.mainIconHeight + 2 + lineHeight(p.condition) + (range ? lineHeight(p.rangeTemperature) + p.rangeBottom : 0));
  const symbol = trailing(icon(m.code, m.isDay, p.mainIconWidth, p.mainIconHeight, true, m.cloud), p.mainIconHeight + 2);
  const description = m.stale && p.inlineStatus
    ? row([text('上次更新', 7, { opacity: .8 }),
      { type: 'date', date: new Date(m.fetchedAt).toISOString(), format: 'relative', font: { size: 7 }, textColor: '#FFFFFFCC', maxLines: 1, minScale: .5 },
      spacer(), text(m.label, p.condition, { textAlign: 'right', minScale: .4 })], { height: lineHeight(p.condition), gap: 2 })
    : trailing(text(m.label, p.condition, { textAlign: 'right' }), lineHeight(p.condition));
  const right = column([spacer(4), symbol, spacer(), description, ...(range ? [range, spacer(p.rangeBottom)] : [])],
    { width: p.rightWidth, height, alignItems: 'end' });
  // Fixed widths and edge spacers keep content aligned inside flexible frames.
  return row([left, spacer(), right], { height, alignItems: 'start' });
}
function hourlyTimeline(m, p) {
  const labelHeight = lineHeight(p.hourLabel), temperatureHeight = lineHeight(p.hourTemperature);
  const height = labelHeight + 2 + p.hourIconHeight + 1 + temperatureHeight;
  const slots = Array.from({ length: 6 }, (_, i) => m.hours[i] || { label: '—', missing: true, temperature: null });
  const columns = slots.map(h => column([
    centered(text(h.label, p.hourLabel, { font: { size: p.hourLabel, weight: 'medium' }, opacity: UI.secondary, textAlign: 'center' }), labelHeight),
    spacer(2),
    h.event ? solarIcon(h.event, p.hourIconWidth, p.hourIconHeight)
      : h.missing ? centered(text('—', 13, { opacity: 0.5 }), p.hourIconHeight) : icon(h.code, h.day, p.hourIconWidth, p.hourIconHeight, false, h.cloud),
    spacer(1),
    centered(text(h.event ? h.event === 'sunrise' ? '日出' : '日落' : temperatureText(h.temperature), h.event ? 11 : p.hourTemperature,
      { font: { size: h.event ? 11 : p.hourTemperature, weight: 'medium' }, textAlign: 'center' }), temperatureHeight),
  ], { width: 28, alignItems: 'center' }));
  return row(columns.flatMap((c, i) => i ? [spacer(), c] : [c]), { height });
}
function dailyCell(node, flex, align) {
  const wrap = align === 'end' ? trailing : align === 'start' ? leading : centered;
  return column([wrap(node, 25)], { flex, alignItems: align });
}
function rangeBar(day, days) {
  const range = temperatureRange(day, days);
  if (!range) return row([spacer()], { flex: 1, height: 4, backgroundColor: '#00000014', borderRadius: 2 });
  const parts = [];
  if (range.before > 0) parts.push({ type: 'spacer', flex: range.before });
  parts.push(row([], { flex: range.span, height: 4, borderRadius: 2,
    backgroundGradient: { type: 'linear', colors: range.colors, stops: range.stops,
      startPoint: { x: 0, y: 0 }, endPoint: { x: 1, y: 0 } } }));
  if (range.after > 0) parts.push({ type: 'spacer', flex: range.after });
  return row(parts, { flex: 1, height: 4, backgroundColor: '#00000014', borderRadius: 2 });
}
function dailyRows(m) {
  const children = [];
  const days = m.notice ? m.futureDays.slice(0, 4) : m.futureDays;
  days.forEach((d, i) => {
    children.push(row([
      dailyCell(text(d.label, 14, { font: { size: 14, weight: 'medium' } }), 1, 'start'),
      dailyCell(d.missing ? text('—', 13, { opacity: 0.4 }) : icon(d.code, true, 26, 24), 1, 'center'),
      dailyCell(text(temperatureText(d.low), 14, { font: { size: 14, weight: 'semibold' }, opacity: 0.38 }), 1.5, 'center'),
      row([spacer(8), rangeBar(d, days)], { flex: 2.4, height: 4 }),
      dailyCell(text(temperatureText(d.high), 14, { font: { size: 14, weight: 'semibold' }, textAlign: 'right' }), 0.7, 'end'),
    ], { height: 25 }));
    if (i < days.length - 1) children.push(spacer());
  });
  return children;
}
function smallContent(m, p) {
  return [
    { type: 'spacer', flex: 1.5 },
    leading(text(m.title, p.title, { font: { size: p.title, weight: 'medium' } }), lineHeight(p.title)),
    leading(text(temperatureText(m.temperature), p.temperature, { font: { size: p.temperature, weight: 'light' } }), lineHeight(p.temperature)),
    leading(icon(m.code, m.isDay, 18, 14, true, m.cloud), 14),
    m.stale ? row([text(m.label, p.condition), spacer(), text('上次更新', 7, { opacity: .8 }),
      { type: 'date', date: new Date(m.fetchedAt).toISOString(), format: 'relative', font: { size: 7 }, textColor: '#FFFFFFCC', maxLines: 1, minScale: .5 }],
      { height: lineHeight(p.condition), gap: 2 }) : leading(text(m.label, p.condition), lineHeight(p.condition)),
    spacer(),
    // Preserve row height when the range is missing to prevent vertical layout shifts.
    m.today ? todayRange(m, p, 'start') : spacer(lineHeight(p.rangeTemperature)),
    { type: 'spacer', flex: 1.3 },
  ];
}
function mediumContent(m, p) {
  return [spacer(), currentHeader(m, p), spacer(2), hourlyTimeline(m, p), spacer()];
}
function largeContent(m, p) {
  // Flexible spacing fits the forecast rows on both standard and compact widgets.
  return [currentHeader(m, p), separator(),
    ...(m.notice ? [row([text(m.notice.text, 12, { minScale: .6 }), spacer()], { height: 25 }), separator()] : []),
    { type: 'spacer', flex: 2 }, hourlyTimeline(m, p),
    { type: 'spacer', flex: 2.5 }, separator(), { type: 'spacer', flex: 2.75 }, ...dailyRows(m),
    { type: 'spacer', flex: 0.5 },
    m.stale ? updateLabel(m.fetchedAt) : spacer(12)];
}
export function renderWidget(m, family, config, refreshAt) {
  const p = profileFor(family, m.stale);
  const render = family === 'systemSmall' ? smallContent : family === 'systemLarge' ? largeContent : mediumContent;
  return { type: 'widget', padding: p.padding, gap: 0, backgroundGradient: themeFor(m), backgroundImage: skyBackground(m, family),
    refreshAfter: new Date(Math.min(refreshAt, m.nextChangeAt ?? refreshAt)).toISOString(), children: render(m, p) };
}
function messageWidget(config, family, message, refreshAt) {
  return { type: 'widget', padding: 12, backgroundGradient: themeFor({ isDay: false }),
    refreshAfter: new Date(refreshAt).toISOString(),
    children: [text(config.title || config.region || '配置天气地区', 14), spacer(),
      text('—', 34), text(message, 11, { maxLines: family === 'systemSmall' ? 2 : 3, opacity: 0.85 }), spacer()] };
}

// The injected clock is for tests; Egern uses the default export with Date.now.
export async function runWidget(ctx, clock = Date.now) {
  const config = settings(ctx.env), family = ctx.widgetFamily || 'systemSmall', now = clock();
  if (!['systemSmall', 'systemMedium', 'systemLarge'].includes(family)) return messageWidget(config, family, '请选择主屏幕小、中或大尺寸', now + 30 * MINUTE);
  if (!config.region || Array.from(config.region).length > 120) return messageWidget(config, family, '请在 REGION 填写完整市区名', now + 30 * MINUTE);
  let geo = read(ctx, 'geo', config.region), snapshot = read(ctx, 'weather', config.region);
  if (!validGeo(geo) || geo.at > now) { remove(ctx, 'geo'); geo = null; }
  if (!validSnapshot(snapshot, now)) { remove(ctx, 'weather'); snapshot = null; }
  if (snapshot?.current && !ageWithin(snapshot.fetchedAt, STALE_LIMIT, now)) {
    snapshot = snapshot.failures ? { version: SNAPSHOT_VERSION, region: config.region, failures: snapshot.failures, retryAt: snapshot.retryAt } : null;
    if (snapshot) write(ctx, 'weather', snapshot); else remove(ctx, 'weather');
  }
  const ttl = config.refreshMinutes * MINUTE;
  const needsToday = snapshot?.current && snapshot.today === undefined
    && !todayTemperatures(snapshot, localParts(now, snapshot).date);
  if (snapshot?.version === SNAPSHOT_VERSION && snapshot.current && !snapshot.failures && !needsToday && ageWithin(snapshot.fetchedAt, ttl, now)) {
    return renderWidget(viewModel(snapshot, config, geo, now), family, config, snapshot.fetchedAt + ttl);
  }
  if (snapshot?.retryAt > now) {
    return snapshot.current ? renderWidget(viewModel(snapshot, config, geo, now, true), family, config, snapshot.retryAt)
      : messageWidget(config, family, '天气暂不可用，稍后重试', snapshot.retryAt);
  }
  try {
    const deadline = now + 25000;
    geo = await coordinates(ctx, config, geo, deadline, clock);
    const raw = await fetchWeather(ctx, geo, deadline, clock);
    snapshot = normalizeWeather(raw, config.region, clock());
    write(ctx, 'weather', snapshot);
    return renderWidget(viewModel(snapshot, config, geo, clock()), family, config, snapshot.fetchedAt + ttl);
  } catch (error) {
    const failedAt = clock();
    snapshot = failureState(config.region, snapshot, failedAt);
    write(ctx, 'weather', snapshot);
    return snapshot.current ? renderWidget(viewModel(snapshot, config, geo, failedAt, true), family, config, snapshot.retryAt)
      : messageWidget(config, family, error instanceof WeatherError ? error.message : '天气暂不可用', snapshot.retryAt);
  }
}
export default async function(ctx) { return runWidget(ctx); }
