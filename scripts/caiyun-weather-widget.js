// Egern native Widget DSL. No browser, Node.js or third-party runtime dependencies.
// API/DSL sources, field units and platform limitations: README.md.
const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const MAX_STALE = 6 * HOUR;
const GEO_TTL = 30 * 24 * HOUR;
const GEO_URL = 'https://starplucker.cyapi.cn/v3/geo/geocode';
const WHITE = '#FFFFFF';
const MUTED = '#FFFFFFBB';
const BLUE = '#A9DDFF';

// All 20 codes in Caiyun's v2.6 skycon table. STORM_RAIN is not thunderstorm.
const WEATHER = {
  CLEAR_DAY: ['晴', 'sun.max.fill', 'clear'],
  CLEAR_NIGHT: ['晴', 'moon.stars.fill', 'clear'],
  PARTLY_CLOUDY_DAY: ['多云', 'cloud.sun.fill', 'cloud'],
  PARTLY_CLOUDY_NIGHT: ['多云', 'cloud.moon.fill', 'cloud'],
  CLOUDY: ['阴', 'cloud.fill', 'cloud'],
  LIGHT_HAZE: ['轻度雾霾', 'sun.haze.fill', 'haze'],
  MODERATE_HAZE: ['中度雾霾', 'sun.haze.fill', 'haze'],
  HEAVY_HAZE: ['重度雾霾', 'sun.haze.fill', 'haze'],
  LIGHT_RAIN: ['小雨', 'cloud.drizzle.fill', 'rain'],
  MODERATE_RAIN: ['中雨', 'cloud.rain.fill', 'rain'],
  HEAVY_RAIN: ['大雨', 'cloud.heavyrain.fill', 'rain'],
  STORM_RAIN: ['暴雨', 'cloud.heavyrain.fill', 'rain'],
  FOG: ['雾', 'cloud.fog.fill', 'haze'],
  LIGHT_SNOW: ['小雪', 'cloud.snow.fill', 'snow'],
  MODERATE_SNOW: ['中雪', 'cloud.snow.fill', 'snow'],
  HEAVY_SNOW: ['大雪', 'cloud.snow.fill', 'snow'],
  STORM_SNOW: ['暴雪', 'cloud.snow.fill', 'snow'],
  DUST: ['浮尘', 'sun.dust.fill', 'haze'],
  SAND: ['沙尘', 'sun.dust.fill', 'haze'],
  WIND: ['大风', 'wind', 'cloud'],
};
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const between = (v, lo, hi) => number(v) !== null && v >= lo && v <= hi ? v : null;
const array = v => Array.isArray(v) ? v : [];
const string = v => typeof v === 'string' ? v.trim() : '';
const temp = v => number(v) === null ? '—' : `${Math.round(v)}°`;
const decimal = v => number(v) === null ? '—' : String(Math.round(v * 10) / 10);
const percent = v => number(v) === null ? '—' : `${Math.round(v)}%`;
const wx = code => Object.prototype.hasOwnProperty.call(WEATHER, code) ? WEATHER[code] : ['天气未知', 'questionmark.circle', 'cloud'];
const timestamp = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
const localDate = (ms, shift) => new Date(ms + shift * 1000).toISOString().slice(0, 10);
const localTime = (ms, shift) => new Date(ms + shift * 1000).toISOString().slice(11, 16);
function problem(message, retry = 15 * MINUTE) {
  const e = new Error(message);
  e.retry = retry;
  return e;
}
function read(ctx, key) {
  try { return ctx.storage ? ctx.storage.getJSON(key) : null; } catch (_) { return null; }
}
function write(ctx, key, value) {
  try { if (ctx.storage) ctx.storage.setJSON(key, value); } catch (_) { /* Network result remains usable. */ }
}
function fingerprint(value) {
  // Namespace the cache when credentials change; never persist the token itself.
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}
function retryDelay(response, now) {
  let value;
  try { value = response.headers.get('Retry-After'); } catch (_) { return 30 * MINUTE; }
  const seconds = string(value) ? Number(value) : NaN;
  const wait = Number.isFinite(seconds) ? seconds * 1000 : (timestamp(value) || now) - now;
  return Math.max(30 * MINUTE, Math.min(wait, 24 * HOUR));
}
async function getJSON(ctx, url, service, now) {
  let response;
  try {
    response = await ctx.http.get(url, { timeout: 8000, credentials: 'omit', redirect: 'error' });
  } catch (_) { throw problem(`${service}连接失败，请检查网络`); }
  if (response.status !== 200) {
    const messages = {
      400: service === '彩云天气' ? '彩云 Token 无效或请求错误' : '城市查询参数无效',
      401: `${service}无访问权限`,
      403: `${service}访问被拒绝，请检查权限`,
      422: `${service}请求参数错误`,
      429: `${service}限流或额度不足，稍后重试`,
    };
    throw problem(messages[response.status] || `${service}暂不可用（HTTP ${response.status}）`,
      response.status === 429 ? retryDelay(response, now) : [400, 401, 403].includes(response.status) ? HOUR : 15 * MINUTE);
  }
  try { return await response.json(); } catch (_) { throw problem(`${service}返回了无效数据`); }
}
function coordinates(item) {
  // Accept numeric strings, but never coerce empty/null/boolean values into zero.
  const parse = v => typeof v === 'string' && v.trim() ? Number(v) : number(v);
  const longitude = between(parse(item && item.longitude), -180, 180);
  const latitude = between(parse(item && item.latitude), -90, 90);
  return longitude === null || latitude === null ? null : { longitude, latitude };
}
async function locate(ctx, city, now) {
  const key = `caiyun:geo:v1:${city}`;
  const cached = read(ctx, key);
  if (cached && cached.city === city && number(cached.at) !== null && now >= cached.at && now - cached.at < GEO_TTL && coordinates(cached)) return cached;
  const body = await getJSON(ctx, `${GEO_URL}?query=${encodeURIComponent(city)}&limit=1&lang=zh_CN`, '城市查询', now);
  if (!body || !Array.isArray(body.items)) throw problem('城市查询返回格式错误');
  if (!body.items.length) throw problem('未找到地区，请填写完整的市、区名称', HOUR);
  const point = coordinates(body.items[0]);
  if (!point) throw problem('城市查询未返回有效坐标');
  const result = { ...point, city, at: now };
  write(ctx, key, result);
  return result;
}
function fieldMap(rows, key) {
  const result = new Map();
  array(rows).forEach(row => {
    if (!row || typeof row !== 'object') return;
    const id = key === 'date' ? string(row.date).slice(0, 10) : timestamp(row.datetime);
    if (id !== null && id !== '') result.set(id, row);
  });
  return result;
}
function normalize(body, now) {
  if (!body || body.status !== 'ok') throw problem('彩云返回失败，请检查 Token、权限和额度');
  const result = body.result || {};
  const r = result.realtime || {};
  if (r.status !== 'ok' || number(r.temperature) === null) throw problem('暂时没有有效的实况天气');
  const observed = number(body.server_time) === null ? now : body.server_time * 1000;
  if (observed > now + 5 * MINUTE || now - observed > MAX_STALE) throw problem('天气数据时间异常或已过期');
  const shift = between(body.tzshift, -43200, 50400);
  if (shift === null) throw problem('天气数据缺少有效时区');
  const h = result.hourly && result.hourly.status === 'ok' ? result.hourly : {};
  const d = result.daily && result.daily.status === 'ok' ? result.daily : {};
  const sky = fieldMap(h.skycon, 'datetime');
  const rain = fieldMap(h.precipitation, 'datetime');
  const wind = fieldMap(h.wind, 'datetime');
  const hourly = [...fieldMap(h.temperature, 'datetime')].sort((a, b) => a[0] - b[0]).map(([time, item]) => ({
    time, temperature: number(item.value), code: string((sky.get(time) || {}).value),
    probability: between((rain.get(time) || {}).probability, 0, 100),
    precipitation: number((rain.get(time) || {}).value),
    windSpeed: number((wind.get(time) || {}).speed), windDirection: between((wind.get(time) || {}).direction, 0, 360),
  })).filter(item => item.time >= now && item.time < now + 24 * HOUR).slice(0, 24);
  const dailySky = fieldMap(d.skycon, 'date');
  const dailyRain = fieldMap(d.precipitation, 'date');
  const astro = fieldMap(d.astro, 'date');
  const today = localDate(now, shift);
  const daily = [...fieldMap(d.temperature, 'date')].filter(([date]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= today)
    .sort((a, b) => a[0].localeCompare(b[0])).slice(0, 7).map(([date, item]) => {
      const a = astro.get(date) || {};
      const lo = number(item.min), hi = number(item.max);
      return { date, min: lo !== null && hi !== null && lo > hi ? null : lo,
        max: lo !== null && hi !== null && lo > hi ? null : hi,
        code: string((dailySky.get(date) || {}).value), probability: between((dailyRain.get(date) || {}).probability, 0, 100),
        sunrise: validClock(a.sunrise && a.sunrise.time), sunset: validClock(a.sunset && a.sunset.time) };
    });
  const m = result.minutely && result.minutely.status === 'ok' ? result.minutely : {};
  const minutes = array(m.precipitation_2h).length ? m.precipitation_2h : array(m.precipitation);
  const elapsed = Math.max(0, Math.floor((now - observed) / MINUTE));
  const minuteValues = minutes.slice(elapsed, 120).map(v => number(v) !== null && v >= 0 ? v : null);
  const aq = r.air_quality || {};
  const localRain = (r.precipitation || {}).local || {};
  return {
    temperature: r.temperature, apparent: number(r.apparent_temperature), code: string(r.skycon),
    humidity: between(r.humidity, 0, 1), visibility: number(r.visibility),
    windSpeed: number((r.wind || {}).speed), windDirection: between((r.wind || {}).direction, 0, 360),
    aqi: number((aq.aqi || {}).chn), aqiText: string((aq.description || {}).chn),
    intensity: localRain.status === 'ok' ? number(localRain.intensity) : null,
    observed, shift, hourly, daily, today: daily.find(day => day.date === today) || {},
    minuteValues, minuteDescription: elapsed <= 15 ? string(m.description) : '',
    minuteSource: string(m.datasource),
    // v2.6 has no documented dedicated minutely precipitation-type field.
    description: string(h.description) || string(result.forecast_keypoint),
    unit: string(body.unit),
  };
}
function validClock(value) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(string(value)) ? value : ''; }
function night(model, time, code) {
  const day = model.daily.find(d => d.date === localDate(time, model.shift));
  const clock = localTime(time, model.shift);
  if (day && day.sunrise && day.sunset) return clock < day.sunrise || clock >= day.sunset;
  if (code.endsWith('_NIGHT')) return true;
  if (code.endsWith('_DAY')) return false;
  // A visual fallback only; never exposed as a calculated sunrise/sunset.
  return clock < '06:00' || clock >= '18:00';
}
function palette(model) {
  const kind = wx(model.code)[2];
  const dark = night(model, model.observed, model.code);
  const colors = dark ? ['#07172F', '#1E3556', '#405675'] : kind === 'rain' ? ['#344D66', '#607C91', '#8297A7']
    : kind === 'haze' ? ['#647580', '#93A2AD', '#B5C0C5'] : kind === 'snow' ? ['#597E9D', '#8BACBF', '#B0C8D6']
    : kind === 'cloud' ? ['#3F6D98', '#739CB9', '#A1BBCD'] : ['#1464B3', '#358DCE', '#75B9E7'];
  if (dark && kind === 'rain') return ['#172631', '#2D4354', '#536777'];
  return colors;
}
function text(value, size = 12, weight = 'regular', color = WHITE, extra = {}) {
  return { type: 'text', text: String(value), font: { size, weight }, textColor: color, maxLines: 1, minScale: 0.75, ...extra };
}
const stack = (children, direction = 'row', extra = {}) => ({ type: 'stack', direction, children: children.filter(Boolean), ...extra });
const column = (children, extra = {}) => stack(children, 'column', { alignItems: 'start', ...extra });
const space = () => ({ type: 'spacer' });
const symbol = (name, size = 20) => ({ type: 'image', src: `sf-symbol:${name}`, width: size, height: size, color: WHITE });
const icon = (code, size) => symbol(wx(code)[1], size);
const divider = () => stack([], 'row', { height: 0.5, backgroundColor: '#FFFFFF30' });
const svg = (body, width, height) => ({ type: 'image', src: `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${width} ${height}'>${body}</svg>`, height, resizeMode: 'contain' });
const hilo = model => `最高 ${temp(model.today.max)}  最低 ${temp(model.today.min)}`;
function foot(model, state, small = false) {
  const stamp = `${localDate(model.observed, model.shift).slice(5).replace('-', '/')} ${localTime(model.observed, model.shift)}`;
  return text(`${state.stale ? '旧数据 ' : small ? '' : '彩云 · '}${stamp}`, small ? 8 : 9, 'regular', MUTED);
}
function temperatureChart(hours, width = 300) {
  const values = hours.map(h => h.temperature).filter(v => v !== null);
  if (values.length < 2) return text('温度趋势数据不足', 10, 'regular', MUTED);
  const low = Math.min(...values), high = Math.max(...values);
  let path = '', drawing = false;
  hours.forEach((h, i) => {
    if (h.temperature === null) { drawing = false; return; }
    const x = 4 + (hours.length === 1 ? 0 : (h.time - hours[0].time) / (hours[hours.length - 1].time - hours[0].time)) * (width - 8);
    const y = 12 - (h.temperature - low) / (high - low || 1) * 10;
    if (i && h.time - hours[i - 1].time > 90 * MINUTE) drawing = false;
    path += `${drawing ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `;
    drawing = true;
  });
  return svg(`<path d='${path}' fill='none' stroke='white' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/>`, width, 14);
}
function minuteChart(model) {
  const v = model.minuteValues;
  if (!v.some(n => n !== null)) return null;
  const max = Math.max(...v.filter(n => n !== null), 0.1);
  let bars = '';
  v.forEach((n, i) => {
    if (n === null) return;
    const h = n === 0 ? 0.6 : Math.max(1, n / max * 8);
    bars += `<rect x='${(i * 300 / v.length).toFixed(2)}' y='${(9 - h).toFixed(2)}' width='${(300 / v.length * 0.7).toFixed(2)}' height='${h.toFixed(2)}' fill='rgb(169,221,255)'/>`;
  });
  const intensity = model.intensity !== null && model.unit === 'metric:v2' ? ` · 当前 ${decimal(model.intensity)}mm/h` : '';
  return stack([text(`${v.length}分降水${intensity}`, 8, 'regular', MUTED), { ...svg(bars, 300, 10), flex: 1 }], 'row', { gap: 6, height: 10 });
}
function hoursRow(model, count, spread = false) {
  const all = model.hourly;
  if (!all.length) return text('小时预报暂不可用', 11, 'regular', MUTED);
  const selected = spread && all.length > count ? Array.from({ length: count }, (_, i) => all[Math.round(i * (all.length - 1) / (count - 1))]) : all.slice(0, count);
  const showRain = selected.some(h => h.probability !== null && h.probability >= 20);
  return stack(selected.map(h => column([
    text(`${localTime(h.time, model.shift).slice(0, 2)}时`, 9, 'medium', MUTED),
    icon(h.code, 15), text(temp(h.temperature), 11, 'medium'),
    showRain ? text(percent(h.probability), 8, 'medium', BLUE) : null,
  ], { flex: 1, alignItems: 'center', gap: 1 })), 'row', { alignItems: 'start' });
}
function dailyRows(model, wide = false) {
  if (!model.daily.length) return [text('每日预报暂不可用', 11, 'regular', MUTED)];
  const bounds = model.daily.flatMap(day => [day.min, day.max]).filter(v => v !== null);
  const low = Math.min(...bounds), high = Math.max(...bounds);
  const today = localDate(Date.now(), model.shift);
  return model.daily.map(day => {
    const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(`${day.date}T12:00:00Z`).getUTCDay()];
    const width = wide ? 160 : 100;
    let track = `<rect x='0' y='3' width='${width}' height='4' rx='2' fill='white' fill-opacity='0.13'/>`;
    if (day.min !== null && day.max !== null && bounds.length) {
      const x = (day.min - low) / (high - low || 1) * (width - 4);
      const length = Math.max(4, (day.max - day.min) / (high - low || 1) * (width - 4));
      track += `<defs><linearGradient id='t'><stop stop-color='rgb(114,216,224)'/><stop offset='1' stop-color='rgb(255,208,119)'/></linearGradient></defs><rect x='${x.toFixed(1)}' y='3' width='${length.toFixed(1)}' height='4' rx='2' fill='url(#t)'/>`;
    }
    return stack([
      stack([text(day.date === today ? '今天' : weekday, 11, 'medium')], 'row', { width: 30 }),
      icon(day.code, 14),
      stack([text(percent(day.probability), 9, 'regular', day.probability >= 20 ? BLUE : MUTED)], 'row', { width: 30 }),
      stack([text(temp(day.min), 11, 'medium', MUTED)], 'row', { width: 28 }),
      { ...svg(track, width, 10), flex: 1 },
      stack([text(temp(day.max), 11, 'medium')], 'row', { width: 28 }),
    ], 'row', { gap: 5, height: 17 });
  });
}
function windLabel(model) {
  const labels = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  const direction = model.windDirection === null ? '' : labels[Math.round(model.windDirection / 45) % 8];
  return `${direction}风 ${decimal(model.windSpeed)}km/h`;
}
function header(model, city) {
  return stack([
    column([text(city, 16, 'semibold'), stack([
      text(temp(model.temperature), 36, 'light'),
      column([text(wx(model.code)[0], 12, 'medium'), text(`体感 ${temp(model.apparent)}`, 10, 'regular', MUTED)], { gap: 3 }),
    ], 'row', { gap: 10 })], { flex: 1 }),
    column([icon(model.code, 28), text(hilo(model), 10, 'medium')], { alignItems: 'end', gap: 5 }),
  ], 'row', { alignItems: 'center', gap: 8 });
}
function render(model, city, family, state) {
  const lock = family.startsWith('accessory');
  const root = { type: 'widget', padding: lock ? 0 : 14, gap: 3,
    refreshAfter: new Date(state.next).toISOString(), children: [] };
  if (!lock) root.backgroundGradient = { type: 'linear', colors: palette(model), startPoint: { x: 0, y: 0 }, endPoint: { x: 0.8, y: 1 } };
  const status = state.stale ? '旧数据' : wx(model.code)[0];
  if (family === 'accessoryInline') {
    root.children = [text(`${city} ${temp(model.temperature)} ${status}`, 12, 'medium')];
  } else if (family === 'accessoryCircular') {
    root.children = [column([icon(model.code, 17), text(temp(model.temperature), 22, 'medium'), text(state.stale ? '旧数据' : city, 8)], { alignItems: 'center', gap: 1, flex: 1 })];
  } else if (family === 'accessoryRectangular') {
    root.children = [text(city, 12, 'semibold'), stack([icon(model.code, 19), text(`${temp(model.temperature)} ${status}`, 17, 'medium')], 'row', { gap: 5 }), text(hilo(model), 10), foot(model, state, true)];
  } else if (family === 'systemSmall') {
    root.children = [text(city, 15, 'semibold'), text(temp(model.temperature), 48, 'light'), space(),
      stack([icon(model.code, 19), text(wx(model.code)[0], 12, 'medium')], 'row', { gap: 5 }), text(hilo(model), 10), foot(model, state, true)];
  } else if (family === 'systemMedium') {
    root.gap = 2;
    root.children = [header(model, city), divider(), hoursRow(model, 5), space(), foot(model, state)];
  } else {
    const wide = family === 'systemExtraLarge';
    const summary = state.stale ? `更新失败 · ${state.reason}` : model.minuteDescription || model.description || '预报说明暂不可用';
    root.children = [header(model, city), text(summary, 10, 'regular', MUTED), minuteChart(model), divider(),
      stack([text(`未来24小时 · ${model.hourly.length}个时段`, 9, 'medium', MUTED), space(), text('降水概率', 8, 'regular', MUTED)]),
      temperatureChart(model.hourly, wide ? 680 : 300), hoursRow(model, wide ? 10 : 6, true), divider(),
      text(`含今天 · ${model.daily.length}天预报`, 9, 'medium', MUTED), ...dailyRows(model, wide),
      space(),
      text(`湿度 ${percent(model.humidity === null ? null : model.humidity * 100)}  ·  ${windLabel(model)}  ·  能见度 ${decimal(model.visibility)}km`, 9, 'regular', MUTED),
      text(`AQI ${model.aqi === null ? '—' : Math.round(model.aqi)} ${model.aqiText}${model.today.sunrise ? `  ·  日出 ${model.today.sunrise}` : ''}${model.today.sunset ? `  日落 ${model.today.sunset}` : ''}`, 9, 'regular', MUTED),
      foot(model, state),
    ].filter(Boolean);
    root.padding = 12;
    root.gap = 1;
  }
  return root;
}
function errorWidget(city, family, message, next) {
  const lock = family.startsWith('accessory');
  const root = { type: 'widget', padding: lock ? 0 : 14, gap: 6,
    refreshAfter: new Date(next).toISOString(), children: [] };
  if (!lock) root.backgroundGradient = { type: 'linear', colors: ['#263F59', '#5A738B'] };
  if (family === 'accessoryInline') root.children = [text(`${city || '天气'} · ${message}`, 11)];
  else if (family === 'accessoryCircular') root.children = [column([symbol('exclamationmark.icloud', 20), text('暂不可用', 10)], { alignItems: 'center' })];
  else root.children = [text(city || '彩云天气', 15, 'semibold'), space(), symbol('exclamationmark.icloud', 24), text(message, 12, 'regular', WHITE, { maxLines: 3 }), space()];
  return root;
}

export default async function(ctx) {
  const now = Date.now();
  const family = string(ctx.widgetFamily) || 'systemMedium';
  const city = string((ctx.env || {}).CITY);
  const token = string((ctx.env || {}).CAIYUN_TOKEN);
  if (!city || !token) return errorWidget(city, family, `请配置 ${!city ? 'CITY' : 'CAIYUN_TOKEN'}`, now + HOUR);
  const key = `caiyun:weather:v1:${city}:${fingerprint(token)}`;
  const saved = read(ctx, key);
  let model = null;
  if (saved && saved.city === city && number(saved.at) !== null && saved.at <= now && now - saved.at < MAX_STALE) {
    try { model = normalize(saved.body, now); } catch (_) { /* Corrupt or expired cached data. */ }
  }
  const block = read(ctx, `${key}:retry`);
  if (block && number(block.until) !== null && block.until > now && block.until <= now + 24 * HOUR) {
    return model ? render(model, city, family, { stale: true, reason: string(block.message), next: block.until })
      : errorWidget(city, family, string(block.message) || '稍后重试', block.until);
  }
  if (model && number(saved.next) !== null && saved.next > now && now - model.observed < 30 * MINUTE) {
    return render(model, city, family, { stale: false, next: saved.next });
  }
  try {
    const point = await locate(ctx, city, now);
    const url = `https://api.caiyunapp.com/v2.6/${encodeURIComponent(token)}/${point.longitude},${point.latitude}/weather?lang=zh_CN&unit=metric%3Av2&hourlysteps=24&dailysteps=7`;
    const body = await getJSON(ctx, url, '彩云天气', now);
    const fresh = normalize(body, now);
    const wet = fresh.minuteValues.some(v => v !== null && v > 0) || ['rain', 'snow'].includes(wx(fresh.code)[2]);
    const next = now + (wet ? 5 : 15) * MINUTE;
    write(ctx, key, { city, body, at: now, next });
    write(ctx, `${key}:retry`, null);
    return render(fresh, city, family, { stale: now - fresh.observed >= 30 * MINUTE, reason: '服务端数据较旧', next });
  } catch (e) {
    // Never render raw network exceptions: they may contain the credential URL.
    const message = e && e.retry ? e.message : '天气暂不可用，请稍后重试';
    const next = now + (e && e.retry ? e.retry : 15 * MINUTE);
    write(ctx, `${key}:retry`, { until: next, message });
    return model ? render(model, city, family, { stale: true, reason: message, next }) : errorWidget(city, family, message, next);
  }
}
