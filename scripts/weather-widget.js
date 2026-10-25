/** 天气 · Egern generic Widget · v1.0.0
 * 独立 ES module，无运行依赖。设置 REGION 即可使用。
 * 持久化仅两个固定键，总预算 4 KiB；ticket 仅存在于本次执行内存。
 */
const H5 = 'https://h5.caiyunapp.com';
const GEO_URL = 'https://starplucker.cyapi.cn/v3/geo/geocode';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  Origin: H5, Referer: `${H5}/`,
};
const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const STALE_LIMIT = 6 * HOUR;
export const CACHE_KEYS = Object.freeze({ geo: 'egern.weather.geo.v1', weather: 'egern.weather.snapshot.v1' });
const LIMITS = { geo: 768, weather: 3328 }; // 包含键名的 UTF-8 字节数。
const finite = n => typeof n === 'number' && Number.isFinite(n);
const numeric = n => (typeof n === 'number' || typeof n === 'string' && n.trim() !== '') && finite(Number(n)) ? Number(n) : null;
const short = (s, n) => Array.from(typeof s === 'string' ? s : '').slice(0, n).join('');
const codeOf = s => typeof s === 'string' && /^[A-Z_]{1,32}$/.test(s) ? s : 'UNKNOWN';
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
  try { ctx.storage?.delete(CACHE_KEYS[kind]); } catch (_) { /* 存储不可用不阻塞界面。 */ }
}
function read(ctx, kind, region) {
  try {
    const raw = ctx.storage?.get ? ctx.storage.get(CACHE_KEYS[kind])
      : JSON.stringify(ctx.storage?.getJSON(CACHE_KEYS[kind]) ?? null);
    if (!raw) return null;
    if (typeof raw !== 'string' || utf8Bytes(raw) + utf8Bytes(CACHE_KEYS[kind]) > LIMITS[kind]) throw Error();
    const value = JSON.parse(raw);
    if (value === null) return null;
    if (value.version !== 1 || value.region !== region) throw Error();
    return value;
  } catch (_) { remove(ctx, kind); return null; }
}
function write(ctx, kind, value) {
  try {
    const raw = JSON.stringify(value);
    if (utf8Bytes(CACHE_KEYS[kind]) + utf8Bytes(raw) > LIMITS[kind]) { remove(ctx, kind); return; }
    if (ctx.storage?.set) ctx.storage.set(CACHE_KEYS[kind], raw);
    else ctx.storage?.setJSON(CACHE_KEYS[kind], value);
  } catch (_) { /* 仍可展示本次网络结果。 */ }
}
function validGeo(g) {
  return onlyKeys(g, ['version', 'region', 'name', 'lon', 'lat', 'at']) && finite(g.at) && finite(g.lon) && Math.abs(g.lon) <= 180
    && finite(g.lat) && Math.abs(g.lat) <= 90 && typeof g.name === 'string';
}
function validSnapshot(s, now) {
  if (!onlyKeys(s, ['version', 'region', 'fetchedAt', 'sourceAt', 'timezone', 'shift', 'current', 'hours', 'days', 'astro', 'failures', 'retryAt'])
    || !Number.isInteger(s.failures) || s.failures < 0 || s.failures > 3
    || !finite(s.retryAt) || s.retryAt < 0 || s.retryAt > now + 30 * MINUTE) return false;
  if (s.fetchedAt === undefined) return s.failures > 0 && onlyKeys(s, ['version', 'region', 'failures', 'retryAt']);
  const nullable = n => n === null || finite(n);
  return finite(s.fetchedAt) && s.fetchedAt <= now && nullable(s.sourceAt)
    && typeof s.timezone === 'string' && finite(s.shift) && Math.abs(s.shift) <= 86400
    && onlyKeys(s.current, ['temperature', 'code']) && finite(s.current?.temperature) && typeof s.current?.code === 'string'
    && Array.isArray(s.hours) && s.hours.length <= 6
    && s.hours.every(h => onlyKeys(h, ['at', 'temperature', 'code']) && finite(h.at) && nullable(h.temperature) && typeof h.code === 'string')
    && Array.isArray(s.days) && s.days.length <= 5
    && s.days.every(d => onlyKeys(d, ['date', 'low', 'high', 'code']) && isDate(d.date) && nullable(d.low) && nullable(d.high) && typeof d.code === 'string')
    && Array.isArray(s.astro) && s.astro.length <= 2
    && s.astro.every(a => onlyKeys(a, ['date', 'rise', 'set']) && isDate(a.date) && nullable(a.rise) && nullable(a.set));
}
function failureState(region, old, now) {
  const failures = Math.min(3, (old?.failures || 0) + 1);
  const base = old?.current && ageWithin(old.fetchedAt, STALE_LIMIT, now) ? prune(old, now) : { version: 1, region };
  return { ...base, failures, retryAt: now + [5, 15, 30][failures - 1] * MINUTE };
}

// ---------- 网络：请求预算统一管理，绝不输出带 ticket 的 URL ----------
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

// ---------- 只把显示需要的数据转换成快照 ----------
export function localParts(ms, meta) {
  try {
    if (meta.timezone && typeof Intl !== 'undefined') {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: meta.timezone, year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
      const p = Object.fromEntries(parts.map(v => [v.type, v.value]));
      return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second) };
    }
  } catch (_) { /* JSCore 不支持时区时回退到服务端偏移。 */ }
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
export function normalizeWeather(data, region, now) {
  const r = data?.result, current = r?.realtime;
  if (data?.status !== 'ok' || current?.status !== 'ok' || numeric(current.temperature) === null) {
    throw new WeatherError('当前天气暂不可用');
  }
  const shift = numeric(data.tzshift);
  const snapshot = { version: 1, region, fetchedAt: now, sourceAt: numeric(data.server_time),
    timezone: short(data.timezone, 64), shift: shift !== null && Math.abs(shift) <= 86400 ? shift : 28800,
    current: { temperature: numeric(current.temperature), code: codeOf(current.skycon) },
    hours: [], days: [], astro: [], failures: 0, retryAt: 0 };
  const today = localParts(now, snapshot).date;
  const daily = r.daily?.status === 'ok' ? r.daily : {};
  const hourly = r.hourly?.status === 'ok' ? r.hourly : {};
  const ht = rows(hourly.temperature, 'datetime', true), hs = rows(hourly.skycon, 'datetime', true);
  const floor = hourFloor(now, snapshot);
  for (let i = 1; i <= 6; i++) {
    const at = floor + i * HOUR;
    if (ht.has(at) || hs.has(at)) snapshot.hours.push({ at, temperature: numeric(ht.get(at)?.value), code: codeOf(hs.get(at)?.value) });
  }
  const dt = rows(daily.temperature, 'date', false), ds = rows(daily.skycon, 'date', false), da = rows(daily.astro, 'date', false);
  for (let i = 0; i < 5; i++) {
    const date = nextDate(today, i);
    if (dt.has(date) || ds.has(date)) {
      const t = dt.get(date);
      let low = numeric(t?.min), high = numeric(t?.max);
      if (low !== null && high !== null && low > high) low = high = null;
      snapshot.days.push({ date, low, high, code: codeOf(ds.get(date)?.value) });
    }
    if (i < 2 && da.has(date)) {
      const a = da.get(date);
      snapshot.astro.push({ date, rise: minutes(a?.sunrise?.time), set: minutes(a?.sunset?.time) });
    }
  }
  return snapshot;
}
function prune(s, now) {
  const today = localParts(now, s).date;
  return { ...s, hours: s.hours.filter(h => h.at > now), days: s.days.filter(d => d.date >= today), astro: s.astro.filter(a => a.date >= today) };
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
    LIGHT_HAZE: ['轻度雾霾', 'haze'], MODERATE_HAZE: ['中度雾霾', 'haze'], HEAVY_HAZE: ['重度雾霾', 'haze'],
    FOG: ['雾', 'fog'], DUST: ['浮尘', 'haze'], SAND: ['沙尘', 'haze'], WIND: ['大风', 'wind'], THUNDER_SHOWER: ['雷阵雨', 'storm'],
  };
  const [label, kind] = known[code] || ['天气未知', 'unknown'];
  return { label, kind };
}
export function viewModel(s, config, geo, now, stale = false) {
  const today = localParts(now, s).date, currentDay = s.days.find(d => d.date === today);
  const floor = hourFloor(now, s), byHour = new Map(s.hours.map(h => [h.at, h]));
  const hours = [{ ...s.current, label: stale ? '上次' : '现在', day: daytime(stale ? s.fetchedAt : now, s, s.current.code) }];
  for (let i = 1; i <= 5; i++) {
    const at = floor + i * HOUR, h = byHour.get(at);
    hours.push({ temperature: h?.temperature ?? null, code: h?.code || 'UNKNOWN',
      label: `${localParts(at, s).hour}时`, day: daytime(at, s, h?.code || ''), missing: !h });
  }
  const days = Array.from({ length: 5 }, (_, i) => {
    const date = nextDate(today, i), d = s.days.find(d => d.date === date);
    const label = i === 0 ? '今天' : i === 1 ? '明天' : ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(`${date}T12:00:00Z`).getUTCDay()];
    return { date, label, low: d?.low ?? null, high: d?.high ?? null, code: d?.code || 'UNKNOWN', missing: !d };
  });
  return { title: config.title || geo?.name || config.region, ...s.current, ...condition(s.current.code),
    low: currentDay?.low ?? null, high: currentDay?.high ?? null, hours, days,
    isDay: daytime(now, s, s.current.code), stale, fetchedAt: s.fetchedAt };
}

// ---------- 图标：组合图标为内置 SVG，简单图标使用 SF Symbols ----------
function svgData(markup) {
  // SVG 只含 ASCII；独立编码以兼容不提供 btoa 的 JSCore。
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let encoded = '';
  for (let i = 0; i < markup.length; i += 3) {
    const bits = (markup.charCodeAt(i) << 16) | ((markup.charCodeAt(i + 1) || 0) << 8) | (markup.charCodeAt(i + 2) || 0);
    encoded += abc[(bits >> 18) & 63] + abc[(bits >> 12) & 63]
      + (i + 1 < markup.length ? abc[(bits >> 6) & 63] : '=') + (i + 2 < markup.length ? abc[bits & 63] : '=');
  }
  return `data:image/svg+xml;base64,${encoded}`;
}
const CLOUD = "<path d='M16 35C8 35 5 30 5 25S9 15 15 15C18 7 28 5 35 9C39 11 41 14 42 18C50 16 58 21 58 27C58 32 54 35 48 35Z' fill='#F3F7FC'/>";
export function iconSource(code, day) {
  const { kind } = condition(code);
  if (kind === 'clear') return { src: `sf-symbol:${day ? 'sun.max.fill' : 'moon.fill'}`, color: day ? '#FFD879' : '#FFF3C8' };
  if (kind === 'cloud') return { src: 'sf-symbol:cloud.fill', color: '#F3F7FC' };
  if (kind === 'wind') return { src: 'sf-symbol:wind', color: '#F3F7FC' };
  if (kind === 'unknown') return { src: 'sf-symbol:questionmark', color: '#FFFFFF99' };
  let body = CLOUD;
  if (kind === 'partly') body = (day ? "<circle cx='44' cy='15' r='12' fill='#FFD879'/>"
    : "<path d='M46 2C28 4 29 26 48 27C38 18 39 11 46 2Z' fill='#FFF3C8'/>") + `<g transform='translate(-2 6)'>${CLOUD}</g>`;
  if (kind === 'rain') body += "<path d='M21 41l-3 7M33 41l-3 7M45 41l-3 7' stroke='#9ED9FF' stroke-width='3' stroke-linecap='round'/>";
  if (kind === 'snow') body += "<g fill='#E2F5FF'><circle cx='20' cy='44' r='2'/><circle cx='32' cy='48' r='2'/><circle cx='44' cy='43' r='2'/></g>";
  if (kind === 'storm') body += "<path d='M34 34L23 47h9l-5 9 18-17h-10l5-5Z' fill='#FFD879'/>";
  if (kind === 'fog' || kind === 'haze') body += `<path d='M10 43h44M16 50h34' stroke='${kind === 'haze' ? '#E6D6B1' : '#DDE6EC'}' stroke-width='3' stroke-linecap='round'/>`;
  return { src: svgData(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 56'>${body}</svg>`) };
}
export function themeFor(model) {
  const themes = {
    clear: ['#1962AB', '#438FD0'], partly: ['#2D679A', '#79A3C3'], cloud: ['#435D76', '#8198AB'],
    rain: ['#29465F', '#64859D'], snow: ['#526F88', '#91AABB'], fog: ['#566B7B', '#8FA0AC'],
    haze: ['#665F58', '#A19784'], storm: ['#29354C', '#5C708A'], wind: ['#34566E', '#829FB3'],
  };
  return { type: 'linear', colors: model.isDay ? themes[model.kind] || themes.cloud : ['#12213D', '#344E72'],
    startPoint: { x: 0, y: 0 }, endPoint: { x: 0.65, y: 1 } };
}
export function rangeURI(day, days, current) {
  const values = days.flatMap(d => [d.low, d.high]).filter(finite);
  const min = Math.min(...values), max = Math.max(...values);
  const position = n => 4 + (max === min ? 0.5 : Math.max(0, Math.min(1, (n - min) / (max - min)))) * 112;
  let body = "<defs><linearGradient id='bar'><stop stop-color='#75D6D8'/><stop offset='.5' stop-color='#B0DBA2'/><stop offset='1' stop-color='#FFD278'/></linearGradient></defs><rect x='2' y='3' width='116' height='4' rx='2' fill='white' fill-opacity='.18'/>";
  if (finite(day.low) && finite(day.high) && day.low <= day.high && values.length) {
    const left = position(day.low), right = position(day.high), width = Math.max(3, right - left);
    body += `<rect x='${Math.min(left, 118 - width)}' y='3' width='${width}' height='4' rx='2' fill='url(#bar)'/>`;
    if (finite(current) && current >= day.low && current <= day.high) body += `<circle cx='${position(current)}' cy='5' r='2.8' fill='white' stroke='#526D84' stroke-width='1'/>`;
  }
  return svgData(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 10'>${body}</svg>`);
}

// ---------- 原生布局：紧凑基准 141x141 / 292x141 / 292x311 pt ----------
const text = (value, size = 12, extra = {}) => ({ type: 'text', text: String(value), font: { size, weight: 'regular' },
  textColor: '#FFFFFF', textAlign: 'left', maxLines: 1, minScale: 0.55, ...extra });
const row = (children, extra = {}) => ({ type: 'stack', direction: 'row', alignItems: 'center', children, ...extra });
const column = (children, extra = {}) => ({ type: 'stack', direction: 'column', alignItems: 'start', children, ...extra });
const spacer = length => length === undefined ? { type: 'spacer' } : { type: 'spacer', length };
const icon = (code, day, size) => ({ type: 'image', ...iconSource(code, day), width: size, height: size, resizeMode: 'contain' });
const detailURL = region => `${H5}/h5?city=${encodeURIComponent(region)}`;
function separator() {
  return { type: 'image', src: svgData("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 320 1'><path d='M0 .5H320' stroke='white' stroke-opacity='.18'/></svg>"), height: 1, resizeMode: 'cover' };
}
function updateLabel(at) {
  return row([text('上次更新', 9, { opacity: 0.8 }), { type: 'date', date: new Date(at).toISOString(), format: 'relative',
    font: { size: 9 }, textColor: '#FFFFFFCC', textAlign: 'left', maxLines: 1, minScale: 0.5 }, spacer()], { gap: 3, height: 12 });
}
function highLow(m, size = 10) { return text(`最高 ${temperatureText(m.high)}  最低 ${temperatureText(m.low)}`, size, { opacity: 0.85 }); }
function hourlyRow(m, large) {
  return row(m.hours.map(h => column([
    text(h.label, large ? 11 : 9, { opacity: 0.78, textAlign: 'center' }),
    h.missing ? row([text('—', 13, { opacity: 0.5 })], { height: large ? 19 : 16 }) : icon(h.code, h.day, large ? 19 : 16),
    text(temperatureText(h.temperature), large ? 13 : 12, { textAlign: 'center' }),
  ], { flex: 1, alignItems: 'center', gap: 1 })), { height: large ? 51 : 44 });
}
function cell(value, width, opacity = 1, align = 'end') {
  return column([text(value, 12, { opacity, textAlign: align === 'end' ? 'right' : 'left' })], { width, alignItems: align });
}
function dailyTable(m) {
  const children = [];
  m.days.forEach((d, i) => {
    children.push(row([
      cell(d.label, 28, 1, 'start'), d.missing ? cell('—', 20, 0.5, 'center') : icon(d.code, true, 20),
      cell(temperatureText(d.low), 31, 0.65),
      { type: 'image', src: rangeURI(d, m.days, !m.stale && i === 0 ? m.temperature : null), height: 9, flex: 1, resizeMode: 'contain' },
      cell(temperatureText(d.high), 31),
    ], { height: 24, gap: 5 }));
    if (i < 4) children.push(spacer());
  });
  return column(children, { flex: 1 });
}
export function renderWidget(m, family, config, refreshAt) {
  const small = family === 'systemSmall', large = family === 'systemLarge';
  const root = { type: 'widget', padding: large ? 16 : 12, gap: 0, backgroundGradient: themeFor(m),
    url: detailURL(config.region), refreshAfter: new Date(refreshAt).toISOString(), children: [] };
  if (small) {
    const size = m.stale ? 36 : 44;
    root.children = [row([text(m.title, 14, { font: { size: 14, weight: 'medium' } }), spacer()], { height: 18 }),
      row([text(temperatureText(m.temperature), size, { font: { size, weight: 'light' } }), spacer()], { height: m.stale ? 44 : 53 }),
      spacer(), row([icon(m.code, m.isDay, 19), text(m.label, 11), spacer()], { gap: 4, height: 20 }),
      row([highLow(m), spacer()], { height: 15 }), ...(m.stale ? [updateLabel(m.fetchedAt)] : [])];
    return root;
  }
  const titleSize = large ? 17 : 14, tempSize = large ? (m.stale ? 37 : 42) : m.stale ? 29 : 39;
  // 实机中 flex 包裹的纵向容器可能把自然宽度内容居中。
  // 标题、温度直接置于横向行首；只让中间 spacer 分配剩余宽度。
  root.children.push(row([
    text(m.title, titleSize, { font: { size: titleSize, weight: 'medium' } }), spacer(),
    row([icon(m.code, m.isDay, large ? 25 : 20), text(m.label, large ? 12 : 10)], { gap: 4 }),
  ], { height: large ? 26 : 20, gap: 6, alignItems: 'center' }));
  root.children.push(row([
    text(temperatureText(m.temperature), tempSize, { font: { size: tempSize, weight: 'light' } }),
    spacer(), highLow(m, large ? 11 : 10),
  ], { height: large ? (m.stale ? 45 : 51) : m.stale ? 35 : 47, gap: 6, alignItems: 'start' }));
  if (!large) root.children.push(spacer());
  root.children.push(spacer(large ? 5 : 2), separator(), spacer(large ? 5 : 2), hourlyRow(m, large));
  if (large) root.children.push(spacer(5), separator(), spacer(6), dailyTable(m));
  if (m.stale) root.children.push(updateLabel(m.fetchedAt));
  return root;
}
function messageWidget(config, family, message, refreshAt) {
  return { type: 'widget', padding: 12, backgroundGradient: themeFor({ isDay: false }),
    refreshAfter: new Date(refreshAt).toISOString(), ...(config.region ? { url: detailURL(config.region) } : {}),
    children: [text(config.title || config.region || '配置天气地区', 14), spacer(),
      text('—', 34), text(message, 11, { maxLines: family === 'systemSmall' ? 2 : 3, opacity: 0.85 }), spacer()] };
}

// clock 参数仅用于开发测试；Egern 使用下方默认导出，时钟为 Date.now。
export async function runWidget(ctx, clock = Date.now) {
  const config = settings(ctx.env), family = ctx.widgetFamily || 'systemSmall', now = clock();
  if (!['systemSmall', 'systemMedium', 'systemLarge'].includes(family)) return messageWidget(config, family, '请选择主屏幕小、中或大尺寸', now + 30 * MINUTE);
  if (!config.region || Array.from(config.region).length > 120) return messageWidget(config, family, '请在 REGION 填写完整市区名', now + 30 * MINUTE);
  let geo = read(ctx, 'geo', config.region), snapshot = read(ctx, 'weather', config.region);
  if (!validGeo(geo) || geo.at > now) { remove(ctx, 'geo'); geo = null; }
  if (!validSnapshot(snapshot, now)) { remove(ctx, 'weather'); snapshot = null; }
  if (snapshot?.current && !ageWithin(snapshot.fetchedAt, STALE_LIMIT, now)) {
    snapshot = snapshot.failures ? { version: 1, region: config.region, failures: snapshot.failures, retryAt: snapshot.retryAt } : null;
    if (snapshot) write(ctx, 'weather', snapshot); else remove(ctx, 'weather');
  }
  const ttl = config.refreshMinutes * MINUTE;
  if (snapshot?.current && !snapshot.failures && ageWithin(snapshot.fetchedAt, ttl, now)) {
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
