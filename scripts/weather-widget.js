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
const SNAPSHOT_VERSION = 2;
// 固定槽名保持不变；内容版本独立升级，避免遗留第三条缓存记录。
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
    if (!(kind === 'weather' ? [1, SNAPSHOT_VERSION].includes(value.version) : value.version === 1) || value.region !== region) throw Error();
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
  if (!onlyKeys(s, ['version', 'region', 'fetchedAt', 'sourceAt', 'timezone', 'shift', 'current', 'hours', 'days', 'today', 'astro', 'failures', 'retryAt'])
    || !Number.isInteger(s.failures) || s.failures < 0 || s.failures > 3
    || !finite(s.retryAt) || s.retryAt < 0 || s.retryAt > now + 30 * MINUTE) return false;
  if (s.fetchedAt === undefined) return s.failures > 0 && onlyKeys(s, ['version', 'region', 'failures', 'retryAt']);
  const nullable = n => n === null || finite(n);
  return finite(s.fetchedAt) && s.fetchedAt <= now && nullable(s.sourceAt)
    && typeof s.timezone === 'string' && finite(s.shift) && Math.abs(s.shift) <= 86400
    && onlyKeys(s.current, ['temperature', 'code']) && finite(s.current?.temperature) && typeof s.current?.code === 'string'
    && Array.isArray(s.hours) && s.hours.length <= 7
    && s.hours.every(h => onlyKeys(h, ['at', 'temperature', 'code']) && finite(h.at) && nullable(h.temperature) && typeof h.code === 'string')
    // 兼容旧版“今天起五天”快照；新写入仅保留明天起四天。
    && Array.isArray(s.days) && s.days.length <= 5
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
function dailyTemperatures(value) {
  let low = numeric(value?.min), high = numeric(value?.max);
  if (low !== null && high !== null && low > high) low = high = null;
  return { low, high };
}
function todayTemperatures(s, date) {
  // 旧五天快照可直接提供今日范围；旧四天快照缺少此数据时由入口补取。
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
    // null 表示本次已查询但无今日范围；字段缺失才表示旧快照尚未查询。
    hours: [], days: [], today: null, astro: [], failures: 0, retryAt: 0 };
  const today = localParts(now, snapshot).date;
  const daily = r.daily?.status === 'ok' ? r.daily : {};
  const hourly = r.hourly?.status === 'ok' ? r.hourly : {};
  const ht = rows(hourly.temperature, 'datetime', true), hs = rows(hourly.skycon, 'datetime', true);
  const floor = hourFloor(now, snapshot);
  // 六个未来整点加一个跨整点备用值，最大刷新间隔为一小时。
  for (let i = 1; i <= 7; i++) {
    const at = floor + i * HOUR;
    if (ht.has(at) || hs.has(at)) snapshot.hours.push({ at, temperature: numeric(ht.get(at)?.value), code: codeOf(hs.get(at)?.value) });
  }
  const dt = rows(daily.temperature, 'date', false), ds = rows(daily.skycon, 'date', false), da = rows(daily.astro, 'date', false);
  const range = dailyTemperatures(dt.get(today));
  if (range.low !== null || range.high !== null) snapshot.today = { date: today, ...range };
  for (let i = 1; i <= 4; i++) {
    const date = nextDate(today, i);
    if (dt.has(date) || ds.has(date)) {
      const { low, high } = dailyTemperatures(dt.get(date));
      snapshot.days.push({ date, low, high, code: codeOf(ds.get(date)?.value) });
    }
  }
  // 天文数据与逐日温度分别裁剪，仍保留今明两天以判断昼夜和暮光。
  for (let i = 0; i < 2; i++) {
    const date = nextDate(today, i);
    if (da.has(date)) {
      const a = da.get(date);
      snapshot.astro.push({ date, rise: minutes(a?.sunrise?.time), set: minutes(a?.sunset?.time) });
    }
  }
  return snapshot;
}
function prune(s, now) {
  const date = localParts(now, s).date, range = todayTemperatures(s, date);
  const { today, ...rest } = s;
  return { ...rest, today: range, hours: s.hours.filter(h => h.at > now),
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
  // 从地区墙上时间反解时间戳；跨夏令时切换时不能直接加到当前时刻。
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
  if (sunset !== null && now >= sunset && now < sunset + 90 * MINUTE) {
    return { phase: 'dusk', amount: (now - sunset) / (90 * MINUTE) };
  }
  if (sunrise !== null && now >= sunrise - 45 * MINUTE && now < sunrise + 15 * MINUTE) {
    return { phase: 'dawn', amount: (now - sunrise + 45 * MINUTE) / HOUR };
  }
  return null;
}
function forecastSummary(day) {
  if (!day || day.missing) return { text: '明天预报暂不可用', symbol: 'calendar' };
  const weather = condition(day.code);
  const label = weather.kind === 'unknown' ? '' : weather.label;
  const temperatures = finite(day.low) && finite(day.high) ? `${temperatureText(day.low)}–${temperatureText(day.high)}`
    : finite(day.high) ? `最高${temperatureText(day.high)}` : finite(day.low) ? `最低${temperatureText(day.low)}` : '';
  if (!label && !temperatures) return { text: '明天预报暂不可用', symbol: 'calendar' };
  return { text: `明天${label}${label && temperatures ? '，' : ''}${temperatures}`,
    symbol: ['rain', 'storm'].includes(weather.kind) ? 'umbrella.fill' : 'calendar' };
}
export function viewModel(s, config, geo, now, stale = false) {
  const today = localParts(now, s).date;
  const floor = hourFloor(now, s), byHour = new Map(s.hours.map(h => [h.at, h]));
  const hours = [];
  for (let i = 1; i <= 6; i++) {
    const at = floor + i * HOUR, h = byHour.get(at);
    hours.push({ at, temperature: h?.temperature ?? null, code: h?.code || 'UNKNOWN',
      label: `${localParts(at, s).hour}时`, day: daytime(at, s, h?.code || ''), missing: !h });
  }
  const futureDays = Array.from({ length: 4 }, (_, i) => {
    const date = nextDate(today, i + 1), d = s.days.find(d => d.date === date);
    const label = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(`${date}T12:00:00Z`).getUTCDay()];
    return { date, label, low: d?.low ?? null, high: d?.high ?? null, code: d?.code || 'UNKNOWN', missing: !d };
  });
  return { title: config.title || geo?.name || config.region, ...s.current, ...condition(s.current.code),
    today: todayTemperatures(s, today), hours, futureDays, summary: forecastSummary(futureDays[0]),
    isDay: daytime(now, s, s.current.code), twilight: twilightAt(s, now), stale, fetchedAt: s.fetchedAt };
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
  if (kind === 'fog' || kind === 'haze') return { src: 'sf-symbol:cloud.fog.fill', color: '#F3F7FC' };
  if (kind === 'wind') return { src: 'sf-symbol:wind', color: '#F3F7FC' };
  if (kind === 'unknown') return { src: 'sf-symbol:questionmark', color: '#FFFFFF99' };
  let body = CLOUD;
  if (kind === 'partly') body = (day ? "<circle cx='44' cy='15' r='12' fill='#FFD879'/>"
    : "<path d='M46 2C28 4 29 26 48 27C38 18 39 11 46 2Z' fill='#FFF3C8'/>") + `<g transform='translate(-2 6)'>${CLOUD}</g>`;
  if (kind === 'rain') {
    if (!day && ['LIGHT_RAIN', 'MODERATE_RAIN'].includes(code)) {
      body = "<path d='M51 2C38 3 36 18 46 24C51 27 58 25 61 21C50 23 44 10 51 2Z' fill='#F6F5ED'/>"
        + `<g transform='translate(-1 4) scale(.9)'>${CLOUD}</g>`;
    }
    body += "<path d='M21 41l-3 7M33 41l-3 7M45 41l-3 7' stroke='#72D4EE' stroke-width='3' stroke-linecap='round'/>";
  }
  if (kind === 'snow') body += "<g fill='#E2F5FF'><circle cx='20' cy='44' r='2'/><circle cx='32' cy='48' r='2'/><circle cx='44' cy='43' r='2'/></g>";
  if (kind === 'storm') body += "<path d='M34 34L23 47h9l-5 9 18-17h-10l5-5Z' fill='#FFD879'/>";
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
  const night = ['cloud', 'fog', 'haze', 'rain', 'storm'].includes(model.kind)
    ? ['#343941', '#2B303A', '#222831'] : ['#201D31', '#252640', '#2B3552'];
  let colors = model.isDay ? themes[model.kind] || themes.cloud : night;
  if (model.twilight && ['clear', 'partly', 'cloud', 'fog', 'haze'].includes(model.kind)) {
    const mix = (a, b, amount) => '#' + [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - amount)
      + parseInt(b.slice(i, i + 2), 16) * amount).toString(16).padStart(2, '0')).join('');
    const t = Math.max(0, Math.min(1, model.twilight.amount));
    const dusk = ['#536C9A', '#9295B4', '#C1A59E'];
    colors = model.twilight.phase === 'dusk' ? dusk.map((c, i) => mix(c, night[i], t))
      : ['#6B7DAB', '#AA9AB5', '#D5B7A8'].map((c, i) => mix(c, (themes[model.kind] || themes.cloud)[i], t));
  }
  return { type: 'linear', colors, stops: [0, 0.56, 1],
    startPoint: { x: 0.5, y: 0 }, endPoint: { x: 0.5, y: 1 } };
}
function skyBackground(m, family) {
  const [w, h] = family === 'systemSmall' ? [164, 164] : family === 'systemLarge' ? [348, 366] : [348, 164];
  const gradient = themeFor(m);
  const stops = gradient.colors.map((color, i) => `<stop offset='${gradient.stops[i]}' stop-color='${color}'/>`).join('');
  const twilight = m.twilight && ['clear', 'partly', 'cloud', 'fog', 'haze'].includes(m.kind);
  const horizon = twilight ? '#F6D2B7' : m.isDay ? '#D9EAF4' : '#B8CDE9';
  // 只绘制静态天色与柔和光照；系统圆角和材质仍交给 Egern / iOS。
  return svgData(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}'>
<defs>
<linearGradient id='sky' x1='0' y1='0' x2='0' y2='1'>${stops}</linearGradient>
<radialGradient id='air'><stop stop-color='#FFFFFF' stop-opacity='${m.isDay ? 0.07 : 0.01}'/><stop offset='1' stop-color='#FFFFFF' stop-opacity='0'/></radialGradient>
<radialGradient id='horizon'><stop stop-color='${horizon}' stop-opacity='${twilight ? 0.15 : m.isDay ? 0.045 : 0.01}'/><stop offset='1' stop-color='${horizon}' stop-opacity='0'/></radialGradient>
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

// ---------- UI：以用户当前实机截图为基准，三尺寸共用排版组件 ----------
const UI = Object.freeze({
  white: '#FFFFFF', secondary: 0.82,
  small: { padding: [7, 16, 7, 16], title: 15, temperature: 44, condition: 12 },
  medium: { padding: [0, 16, 0, 16], title: 16, temperature: 44, condition: 14,
    leftWidth: 120, rightWidth: 136, mainIconWidth: 20, mainIconHeight: 16,
    rangeTemperature: 24, rangeLabel: 9, rangeBottom: 4,
    hourLabel: 12, hourTemperature: 14, hourIconWidth: 22, hourIconHeight: 19 },
  large: { padding: 16, title: 17, temperature: 44, condition: 14,
    leftWidth: 124, rightWidth: 136, mainIconWidth: 22, mainIconHeight: 18,
    rangeTemperature: 24, rangeLabel: 9, rangeBottom: 4,
    hourLabel: 12, hourTemperature: 14, hourIconWidth: 22, hourIconHeight: 19 },
});
const lineHeight = size => Math.ceil(size * 1.2);
function profileFor(family, stale) {
  const key = family === 'systemSmall' ? 'small' : family === 'systemLarge' ? 'large' : 'medium';
  const p = { ...UI[key] };
  if (!stale) return p;
  return { ...p, title: 14, temperature: key === 'large' ? 37 : 34, condition: 11,
    rangeTemperature: 18, rangeLabel: 8, rangeBottom: 3,
    mainIconWidth: 18, mainIconHeight: 15, hourLabel: 11, hourTemperature: 13, hourIconWidth: 20, hourIconHeight: 17 };
}
const text = (value, size = 12, extra = {}) => ({ type: 'text', text: String(value), font: { size, weight: 'regular' },
  textColor: UI.white, textAlign: 'left', maxLines: 1, minScale: 0.55, ...extra });
const row = (children, extra = {}) => ({ type: 'stack', direction: 'row', alignItems: 'center', children, ...extra });
const column = (children, extra = {}) => ({ type: 'stack', direction: 'column', alignItems: 'start', children, ...extra });
const spacer = length => length === undefined ? { type: 'spacer' } : { type: 'spacer', length };
const icon = (code, day, width, height = width) => ({ type: 'image', ...iconSource(code, day), width, height, resizeMode: 'contain' });
const detailURL = `${H5}/h5`;
// WidgetKit 先把点击 URL 交给宿主；使用 Egern 官方 x-success 回调转交网页。
// connections 仅打开列表，不启动/停止 VPN，也不修改配置。
const widgetTapURL = `egern:/connections?x-success=${encodeURIComponent(detailURL)}`;
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
function todayRange(m, p) {
  const label = last => column([text('最', p.rangeLabel), text(last, p.rangeLabel)],
    { width: p.rangeLabel, alignItems: 'center' });
  const value = n => text(temperatureText(n), p.rangeTemperature,
    { font: { size: p.rangeTemperature, weight: 'light' }, textAlign: 'right' });
  // 在固定宽度内使用前置弹性间距，确保最低温的右边缘与天气文字一致。
  return row([spacer(), label('高'), value(m.today.high), spacer(5), label('低'), value(m.today.low)],
    { width: p.rightWidth, height: lineHeight(p.rangeTemperature), gap: 1 });
}
function currentHeader(m, p) {
  const title = text(m.title, p.title, { font: { size: p.title, weight: 'medium' } });
  const temperature = text(temperatureText(m.temperature), p.temperature, { font: { size: p.temperature, weight: 'light' } });
  const left = column([leading(title, lineHeight(p.title)), leading(temperature, lineHeight(p.temperature))], { width: p.leftWidth });
  const range = m.today ? todayRange(m, p) : null;
  const height = Math.max(lineHeight(p.title) + lineHeight(p.temperature),
    4 + p.mainIconHeight + 2 + lineHeight(p.condition) + (range ? lineHeight(p.rangeTemperature) + p.rangeBottom : 0));
  const symbol = trailing(icon(m.code, m.isDay, p.mainIconWidth, p.mainIconHeight), p.mainIconHeight + 2);
  const description = trailing(text(m.label, p.condition, { textAlign: 'right' }), lineHeight(p.condition));
  const right = column([spacer(4), symbol, spacer(), description, ...(range ? [range, spacer(p.rangeBottom)] : [])],
    { width: p.rightWidth, height, alignItems: 'end' });
  // 使用固定宽度、内部首尾 spacer；不让 flex frame 改变内容的实际对齐。
  return row([left, spacer(), right], { height, alignItems: 'start' });
}
function hourlyTimeline(m, p) {
  const labelHeight = lineHeight(p.hourLabel), temperatureHeight = lineHeight(p.hourTemperature);
  const height = labelHeight + 4 + p.hourIconHeight + 3 + temperatureHeight;
  const slots = Array.from({ length: 6 }, (_, i) => m.hours[i] || { label: '—', missing: true, temperature: null });
  const columns = slots.map(h => column([
    centered(text(h.label, p.hourLabel, { font: { size: p.hourLabel, weight: 'medium' }, opacity: UI.secondary, textAlign: 'center' }), labelHeight),
    spacer(4),
    h.missing ? centered(text('—', 13, { opacity: 0.5 }), p.hourIconHeight) : icon(h.code, h.day, p.hourIconWidth, p.hourIconHeight),
    spacer(3),
    centered(text(temperatureText(h.temperature), p.hourTemperature,
      { font: { size: p.hourTemperature, weight: 'medium' }, textAlign: 'center' }), temperatureHeight),
  ], { width: 28, alignItems: 'center' }));
  return row(columns.flatMap((c, i) => i ? [spacer(), c] : [c]), { height });
}
function dailyCell(node, flex, align) {
  const wrap = align === 'end' ? trailing : align === 'start' ? leading : centered;
  return column([wrap(node, 25)], { flex, alignItems: align });
}
function rangeBar(day, days) {
  const range = temperatureRange(day, days);
  if (!range) return row([spacer()], { flex: 1, height: 4, backgroundColor: '#FFFFFF08', borderRadius: 2 });
  const parts = [];
  if (range.before > 0) parts.push({ type: 'spacer', flex: range.before });
  parts.push(row([], { flex: range.span, height: 4, borderRadius: 2,
    backgroundGradient: { type: 'linear', colors: range.colors, stops: range.stops,
      startPoint: { x: 0, y: 0 }, endPoint: { x: 1, y: 0 } } }));
  if (range.after > 0) parts.push({ type: 'spacer', flex: range.after });
  return row(parts, { flex: 1, height: 4 });
}
function dailyTable(m) {
  const children = [{ type: 'spacer', flex: 0.5 }];
  m.futureDays.forEach((d, i) => {
    children.push(row([
      dailyCell(text(d.label, 14, { font: { size: 14, weight: 'medium' } }), 1, 'start'),
      dailyCell(d.missing ? text('—', 13, { opacity: 0.4 }) : icon(d.code, true, 26, 24), 1, 'center'),
      dailyCell(text(temperatureText(d.low), 14, { font: { size: 14, weight: 'semibold' }, opacity: 0.38 }), 1.5, 'center'),
      row([spacer(8), rangeBar(d, m.futureDays)], { flex: 2.4, height: 4 }),
      dailyCell(text(temperatureText(d.high), 14, { font: { size: 14, weight: 'semibold' }, textAlign: 'right' }), 0.7, 'end'),
    ], { height: 25 }));
    if (i < 3) children.push(spacer());
  });
  children.push({ type: 'spacer', flex: 0.5 });
  return column(children, { flex: 1 });
}
function summaryRow(m) {
  return row([{ type: 'image', src: `sf-symbol:${m.summary.symbol}`, width: 16, height: 16, color: UI.white },
    text(m.summary.text, 13, { minScale: 0.7 }), spacer()], { height: 28, gap: 7 });
}
function smallContent(m, p) {
  return [
    leading(text(m.title, p.title, { font: { size: p.title, weight: 'medium' } }), lineHeight(p.title)),
    leading(text(temperatureText(m.temperature), p.temperature, { font: { size: p.temperature, weight: 'light' } }), lineHeight(p.temperature)),
    spacer(),
    leading(icon(m.code, m.isDay, 18, 14), 14),
    leading(text(m.label, p.condition), lineHeight(p.condition)),
    ...(m.stale ? [updateLabel(m.fetchedAt)] : []),
  ];
}
function mediumContent(m, p) {
  return [spacer(), currentHeader(m, p), spacer(3), hourlyTimeline(m, p),
    ...(m.stale ? [updateLabel(m.fetchedAt)] : []), spacer()];
}
function largeContent(m, p) {
  return [currentHeader(m, p), separator(), summaryRow(m), separator(), spacer(4), hourlyTimeline(m, p),
    spacer(4), separator(), spacer(8), dailyTable(m),
    ...(m.stale ? [updateLabel(m.fetchedAt)] : [])];
}
export function renderWidget(m, family, config, refreshAt) {
  const p = profileFor(family, m.stale);
  const render = family === 'systemSmall' ? smallContent : family === 'systemLarge' ? largeContent : mediumContent;
  return { type: 'widget', padding: p.padding, gap: 0, backgroundGradient: themeFor(m), backgroundImage: skyBackground(m, family),
    url: widgetTapURL, refreshAfter: new Date(refreshAt).toISOString(), children: render(m, p) };
}
function messageWidget(config, family, message, refreshAt) {
  return { type: 'widget', padding: 12, backgroundGradient: themeFor({ isDay: false }),
    refreshAfter: new Date(refreshAt).toISOString(), url: widgetTapURL,
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
    snapshot = snapshot.failures ? { version: SNAPSHOT_VERSION, region: config.region, failures: snapshot.failures, retryAt: snapshot.retryAt } : null;
    if (snapshot) write(ctx, 'weather', snapshot); else remove(ctx, 'weather');
  }
  const ttl = config.refreshMinutes * MINUTE;
  const needsToday = family !== 'systemSmall' && snapshot?.current && snapshot.today === undefined
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
