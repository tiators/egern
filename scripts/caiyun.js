// Egern 天气小组件：数据来自彩云天气，视觉参照 iOS 原生天气小组件。
// 环境变量：CAIYUN_TOKEN（彩云 Token）、CITY（城市或市区名称）。

const GEOCODE_URL = 'https://starplucker.cyapi.cn/v3/geo/geocode';
const WEATHER_BASE = 'https://api.caiyunapp.com/v2.6';
const REFRESH_OK_MIN = 30;
const REFRESH_FAIL_MIN = 10;
const MAX_STALE_MS = 24 * 3600 * 1000;
const MIN_SHOWN_PROB = 20;

const WHITE = '#FFFFFF';
const SECONDARY = 'rgba(255,255,255,0.72)';
const RAIN_BLUE = '#7FD4FF';
const DIVIDER = 'rgba(255,255,255,0.22)';

// 彩云 v2.6 全部 skycon。彩云没有雷雨代码，因此不存在雷雨映射。
const SKYCON = {
  CLEAR_DAY: { text: '晴', icon: 'sun.max.fill', theme: 'clear' },
  CLEAR_NIGHT: { text: '晴', icon: 'moon.stars.fill', theme: 'clear' },
  PARTLY_CLOUDY_DAY: { text: '多云', icon: 'cloud.sun.fill', theme: 'partly' },
  PARTLY_CLOUDY_NIGHT: { text: '多云', icon: 'cloud.moon.fill', theme: 'partly' },
  CLOUDY: { text: '阴', icon: 'cloud.fill', theme: 'cloudy' },
  LIGHT_HAZE: { text: '轻度雾霾', icon: 'sun.haze.fill', theme: 'haze' },
  MODERATE_HAZE: { text: '中度雾霾', icon: 'sun.haze.fill', theme: 'haze' },
  HEAVY_HAZE: { text: '重度雾霾', icon: 'sun.haze.fill', theme: 'haze' },
  LIGHT_RAIN: { text: '小雨', icon: 'cloud.drizzle.fill', theme: 'rain' },
  MODERATE_RAIN: { text: '中雨', icon: 'cloud.rain.fill', theme: 'rain' },
  HEAVY_RAIN: { text: '大雨', icon: 'cloud.heavyrain.fill', theme: 'rain' },
  STORM_RAIN: { text: '暴雨', icon: 'cloud.heavyrain.fill', theme: 'rain' },
  FOG: { text: '雾', icon: 'cloud.fog.fill', theme: 'haze' },
  LIGHT_SNOW: { text: '小雪', icon: 'cloud.snow.fill', theme: 'snow' },
  MODERATE_SNOW: { text: '中雪', icon: 'cloud.snow.fill', theme: 'snow' },
  HEAVY_SNOW: { text: '大雪', icon: 'cloud.snow.fill', theme: 'snow' },
  STORM_SNOW: { text: '暴雪', icon: 'cloud.snow.fill', theme: 'snow' },
  DUST: { text: '浮尘', icon: 'sun.dust.fill', theme: 'haze' },
  SAND: { text: '沙尘', icon: 'sun.dust.fill', theme: 'haze' },
  WIND: { text: '大风', icon: 'wind', theme: 'cloudy' },
};
const UNKNOWN_SKY = { text: '--', icon: 'cloud.fill', theme: 'cloudy' };

const THEMES = {
  clear: { day: ['#1F6FC4', '#4A9FE3', '#86C5F0'], night: ['#050B1F', '#101E45', '#233A6B'] },
  partly: { day: ['#2C6FB5', '#5F9BD2', '#9CC3E3'], night: ['#0B1228', '#1B2A4D', '#34466D'] },
  cloudy: { day: ['#54687F', '#75899E', '#9AAABA'], night: ['#1A212D', '#2D3747', '#465162'] },
  rain: { day: ['#37465A', '#536577', '#74838F'], night: ['#111824', '#222D3C', '#3A4554'] },
  snow: { day: ['#62799A', '#8AA0BA', '#B5C4D4'], night: ['#1B2437', '#32405A', '#56647C'] },
  haze: { day: ['#786F63', '#968C7D', '#B5AB9A'], night: ['#26231F', '#3D3933', '#58534A'] },
};

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (v) => (Array.isArray(v) ? v : []);
const sky = (code) => SKYCON[code] || UNKNOWN_SKY;

function fmtTemp(v) {
  if (num(v) === null) return '--';
  const r = Math.round(v);
  return `${r === 0 ? 0 : r}°`;
}

function shouldShowProb(p) {
  return num(p) !== null && p >= MIN_SHOWN_PROB;
}

function fail(title, detail) {
  const e = new Error(title);
  e.title = title;
  e.detail = detail;
  return e;
}

function storeGet(ctx, key) {
  try {
    return ctx.storage.getJSON(key);
  } catch (_) {
    return null;
  }
}

function storeSet(ctx, key, value) {
  try {
    ctx.storage.setJSON(key, value);
  } catch (_) {
    // 存储不可用时不影响本次展示，只是失去兜底数据。
  }
}

async function requestJSON(ctx, url, timeout) {
  let res;
  try {
    res = await ctx.http.get(url, { timeout });
  } catch (_) {
    throw fail('网络连接失败', '请检查网络后稍后再试');
  }
  if (res.status === 400 || res.status === 401) throw fail('Token 无效', '请检查 CAIYUN_TOKEN');
  if (res.status === 403) throw fail('Token 已禁用', '或请求 IP 不在白名单内');
  if (res.status === 422) throw fail('请求参数有误', '请检查 CITY 配置');
  if (res.status === 429) throw fail('请求额度已用尽', '请稍后再试');
  if (res.status !== 200) throw fail('天气服务暂不可用', `HTTP ${res.status}`);
  try {
    return await res.json();
  } catch (_) {
    throw fail('数据解析失败', '服务返回了异常内容');
  }
}

async function resolveCity(ctx, city) {
  const key = `geo:${city}`;
  const cached = storeGet(ctx, key);
  if (cached && num(cached.lat) !== null && num(cached.lng) !== null) return cached;

  const url = `${GEOCODE_URL}?query=${encodeURIComponent(city)}&limit=1&lang=zh_CN`;
  const data = await requestJSON(ctx, url, 6000);
  const item = arr(data && data.items)[0];
  if (!item || num(item.latitude) === null || num(item.longitude) === null) {
    throw fail('未找到该地区', `请检查 CITY：${city}`);
  }
  const place = { name: item.name || city, lat: item.latitude, lng: item.longitude };
  storeSet(ctx, key, place);
  return place;
}

async function fetchWeather(ctx, token, place) {
  const url = `${WEATHER_BASE}/${token}/${place.lng},${place.lat}/weather` +
    '?dailysteps=7&hourlysteps=25&unit=metric:v2&lang=zh_CN';
  const data = await requestJSON(ctx, url, 8000);
  if (!data || data.status !== 'ok' || !data.result) {
    throw fail('天气数据获取失败', '接口返回异常状态');
  }
  return data;
}

function parseMinutely(result, hours) {
  const m = result.minutely;
  const keypoint = typeof result.forecast_keypoint === 'string' ? result.forecast_keypoint : null;
  if (!m || m.status !== 'ok') {
    return { available: false, summary: keypoint, soon: false, intensity: null, type: null, probability: null };
  }
  const series = arr(m.precipitation_2h).map(num).filter((v) => v !== null);
  const soon = series.some((v) => v > 0);
  const wet = hours.slice(0, 3).find((h) => /RAIN|SNOW/.test(h.skycon || ''));
  return {
    available: true,
    summary: m.description || keypoint,
    soon,
    intensity: series.length ? Math.max(...series) : null,
    type: !soon ? null : wet && /SNOW/.test(wet.skycon) ? '雪' : '雨',
    probability: arr(m.probability).map(num).filter((v) => v !== null),
  };
}

function parseClock(t) {
  const match = typeof t === 'string' ? t.match(/^(\d{1,2}):(\d{2})$/) : null;
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function resolveNight(skycon, astro, localMs) {
  const d = new Date(localMs);
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  const rise = parseClock(astro && astro.sunrise && astro.sunrise.time);
  const set = parseClock(astro && astro.sunset && astro.sunset.time);
  if (rise !== null && set !== null) return minutes < rise || minutes >= set;
  if (/_NIGHT$/.test(skycon || '')) return true;
  if (/_DAY$/.test(skycon || '')) return false;
  return minutes < 6 * 60 || minutes >= 18 * 60;
}

// 当天的 daily 只覆盖剩余时段，这里并入本次可见的温度和当天已存储的高低温。
function mergeToday(ctx, cityKey, days, hours, current) {
  const today = days[0];
  if (!today) return;
  const key = `today:${cityKey}`;
  const saved = storeGet(ctx, key);
  const samples = [today.max, today.min, current];
  hours.forEach((h) => {
    if ((h.time || '').slice(0, 10) === today.date) samples.push(h.temp);
  });
  if (saved && saved.date === today.date) samples.push(saved.max, saved.min);
  const valid = samples.map(num).filter((v) => v !== null);
  if (!valid.length) return;
  today.max = Math.max(...valid);
  today.min = Math.min(...valid);
  storeSet(ctx, key, { date: today.date, max: today.max, min: today.min });
}

function normalize(ctx, cityKey, place, data) {
  const result = data.result;
  const rt = result.realtime && result.realtime.status === 'ok' ? result.realtime : null;
  const hourly = result.hourly || {};
  const daily = result.daily || {};
  const tzshift = num(data.tzshift) === null ? 0 : data.tzshift;

  const temps = arr(hourly.temperature);
  const precip = arr(hourly.precipitation);
  const winds = arr(hourly.wind);
  const hours = arr(hourly.skycon).map((s, i) => ({
    time: s.datetime,
    skycon: s.value,
    temp: num(temps[i] && temps[i].value),
    prob: num(precip[i] && precip[i].probability),
    wind: num(winds[i] && winds[i].speed),
  }));

  const dTemps = arr(daily.temperature);
  const dPrecip = arr(daily.precipitation);
  const astro = arr(daily.astro);
  const days = arr(daily.skycon).map((s, i) => ({
    date: (s.date || '').slice(0, 10),
    skycon: s.value,
    max: num(dTemps[i] && dTemps[i].max),
    min: num(dTemps[i] && dTemps[i].min),
    prob: num(dPrecip[i] && dPrecip[i].probability),
    sunrise: (astro[i] && astro[i].sunrise && astro[i].sunrise.time) || null,
    sunset: (astro[i] && astro[i].sunset && astro[i].sunset.time) || null,
  }));

  if (!rt && !hours.length && !days.length) throw fail('暂无天气数据', '接口未返回可用内容');

  const skycon = rt ? rt.skycon : hours[0] && hours[0].skycon;
  const temperature = rt ? num(rt.temperature) : hours[0] ? hours[0].temp : null;
  mergeToday(ctx, cityKey, days, hours, temperature);

  const air = rt && rt.air_quality;
  return {
    city: place.name,
    tzshift,
    astro: astro[0] || null,
    current: {
      skycon,
      temp: temperature,
      feels: rt ? num(rt.apparent_temperature) : null,
      humidity: rt ? num(rt.humidity) : null,
      windSpeed: rt && rt.wind ? num(rt.wind.speed) : null,
      windDirection: rt && rt.wind ? num(rt.wind.direction) : null,
      visibility: rt ? num(rt.visibility) : null,
      aqi: air && air.aqi ? num(air.aqi.chn) : null,
      aqiText: air && air.description ? air.description.chn || null : null,
    },
    minutely: parseMinutely(result, hours),
    hours,
    days,
  };
}

// 使用缓存时，丢弃已过去的小时和日期，避免把旧预报当成当前预报。
function rollForward(model, nowMs) {
  const localDate = new Date(nowMs + model.tzshift * 1000).toISOString().slice(0, 10);
  return {
    ...model,
    hours: model.hours.filter((h) => Date.parse(h.time) > nowMs - 3600 * 1000),
    days: model.days.filter((d) => d.date >= localDate),
  };
}

// ---------- 视图元素 ----------

function text(content, size, opts = {}) {
  const { weight = 'regular', color = WHITE, ...rest } = opts;
  return {
    type: 'text',
    text: String(content),
    font: { size, weight },
    textColor: color,
    maxLines: 1,
    minScale: 0.7,
    ...rest,
  };
}

function icon(name, size, color = WHITE) {
  return {
    type: 'image',
    src: `sf-symbol:${name}`,
    width: size,
    height: size,
    color,
    resizeMode: 'contain',
  };
}

function row(children, opts = {}) {
  return { type: 'stack', direction: 'row', alignItems: 'center', children, ...opts };
}

function col(children, opts = {}) {
  return { type: 'stack', direction: 'column', alignItems: 'start', children, ...opts };
}

const spacer = (length) => (length === undefined ? { type: 'spacer' } : { type: 'spacer', length });

function fixed(width, child, align) {
  const children = [];
  if (align !== 'start') children.push(spacer());
  children.push(child);
  if (align !== 'end') children.push(spacer());
  return row(children, { width });
}

function divider() {
  return { type: 'stack', height: 0.5, backgroundColor: DIVIDER, children: [spacer()] };
}

function background(model) {
  const theme = THEMES[sky(model.current.skycon).theme];
  const nowMs = model.nowMs + model.tzshift * 1000;
  const colors = resolveNight(model.current.skycon, model.astro, nowMs) ? theme.night : theme.day;
  return {
    type: 'linear',
    colors,
    stops: [0, 0.55, 1],
    startPoint: { x: 0.5, y: 0 },
    endPoint: { x: 0.5, y: 1 },
  };
}

function hiLo(today) {
  return `最高${fmtTemp(today && today.max)} 最低${fmtTemp(today && today.min)}`;
}

function cityLabel(model) {
  return model.staleSince ? `${model.city} · ${model.staleSince}` : model.city;
}

function hourLabel(h, index, stale) {
  if (index === 0 && !stale) return '现在';
  const hour = Number((h.time || '').slice(11, 13));
  return Number.isFinite(hour) && (h.time || '').length > 12 ? `${hour}时` : '--';
}

function hourColumns(model, hours) {
  const withProb = hours.some((h) => shouldShowProb(h.prob));
  const stale = Boolean(model.staleSince);
  return row(hours.map((h, i) => {
    const iconStack = [icon(sky(h.skycon).icon, 20)];
    if (shouldShowProb(h.prob)) iconStack.push(text(`${Math.round(h.prob)}%`, 10, { weight: 'semibold', color: RAIN_BLUE }));
    const temp = i === 0 && !stale ? model.current.temp : h.temp;
    return col([
      text(hourLabel(h, i, stale), 12, { weight: 'medium', color: SECONDARY }),
      col(iconStack, { alignItems: 'center', height: withProb ? 34 : 24, gap: 1 }),
      text(fmtTemp(temp), 14, { weight: 'medium' }),
    ], { alignItems: 'center', flex: 1, gap: 4 });
  }));
}

function header(model) {
  const today = model.days[0];
  const c = sky(model.current.skycon);
  return row([
    col([
      text(cityLabel(model), 16, { weight: 'semibold' }),
      text(fmtTemp(model.current.temp), 42, { weight: 'light' }),
    ], { flex: 1 }),
    col([
      icon(c.icon, 20),
      text(c.text, 13, { weight: 'medium' }),
      text(hiLo(today), 12, { weight: 'medium' }),
      text(`体感${fmtTemp(model.current.feels)}`, 12, { color: SECONDARY }),
    ], { alignItems: 'end', gap: 2 }),
  ], { alignItems: 'start' });
}

function small(model) {
  const c = sky(model.current.skycon);
  return [
    text(cityLabel(model), 16, { weight: 'semibold' }),
    text(fmtTemp(model.current.temp), 44, { weight: 'light' }),
    spacer(),
    icon(c.icon, 18),
    spacer(3),
    text(c.text, 13, { weight: 'medium' }),
    text(hiLo(model.days[0]), 13, { weight: 'medium' }),
  ];
}

function medium(model) {
  return [
    header(model),
    spacer(),
    hourColumns(model, model.hours.slice(0, 6)),
  ];
}

// 按绝对温度取色，接近原生温度条。SVG 内不使用 #，避免 data URI 被当作片段截断。
const TEMP_STOPS = [
  [-5, [92, 150, 240]], [8, [90, 200, 220]], [16, [130, 210, 130]],
  [24, [245, 205, 80]], [30, [245, 150, 60]], [36, [235, 85, 70]],
];

function tempColor(t) {
  const stops = TEMP_STOPS;
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, a] = stops[i - 1];
      const [t1, b] = stops[i];
      const k = (t - t0) / (t1 - t0);
      return a.map((v, j) => Math.round(v + (b[j] - v) * k));
    }
  }
  return stops[stops.length - 1][1];
}

function rangeBar(day, lo, hi, currentTemp) {
  const W = 110;
  const H = 5;
  const R = H / 2;
  const span = Math.max(hi - lo, 1);
  const x = (t) => R + ((t - lo) / span) * (W - H);
  const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
  let parts = `<rect x='0' y='0' width='${W}' height='${H}' rx='${R}' fill='rgba(255,255,255,0.18)'/>`;
  if (day.min !== null && day.max !== null) {
    const x0 = x(day.min);
    const x1 = x(day.max);
    const steps = Math.max(1, Math.ceil((x1 - x0) / 4));
    parts += `<circle cx='${x0.toFixed(1)}' cy='${R}' r='${R}' fill='${rgb(tempColor(day.min))}'/>`;
    parts += `<circle cx='${x1.toFixed(1)}' cy='${R}' r='${R}' fill='${rgb(tempColor(day.max))}'/>`;
    for (let i = 0; i < steps; i++) {
      const a = x0 + ((x1 - x0) * i) / steps;
      const b = x0 + ((x1 - x0) * (i + 1)) / steps;
      const t = day.min + ((day.max - day.min) * (i + 0.5)) / steps;
      parts += `<rect x='${a.toFixed(1)}' y='0' width='${(b - a + 0.3).toFixed(1)}' height='${H}' fill='${rgb(tempColor(t))}'/>`;
    }
    if (currentTemp !== null) {
      parts += `<circle cx='${x(currentTemp).toFixed(1)}' cy='${R}' r='${R}' fill='white'/>`;
    }
  }
  return {
    type: 'image',
    src: `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${W} ${H}'>${parts}</svg>`,
    width: W,
    height: H,
    resizeMode: 'contain',
  };
}

function weekdayLabel(date, index) {
  if (index === 0) return '今天';
  const [y, m, d] = date.split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return Number.isFinite(w) ? `周${'日一二三四五六'[w]}` : '--';
}

function dayRows(model) {
  const days = model.days.slice(0, 7);
  const known = days.flatMap((d) => [d.min, d.max]).filter((v) => v !== null);
  const lo = known.length ? Math.min(...known) : 0;
  const hi = known.length ? Math.max(...known) : 1;
  return days.map((d, i) => {
    const prob = shouldShowProb(d.prob)
      ? [spacer(2), text(`${Math.round(d.prob)}%`, 10, { weight: 'semibold', color: RAIN_BLUE })]
      : [];
    return row([
      fixed(40, text(weekdayLabel(d.date, i), 14, { weight: 'medium' }), 'start'),
      fixed(54, row([icon(sky(d.skycon).icon, 16), ...prob]), 'start'),
      fixed(32, text(fmtTemp(d.min), 14, { weight: 'medium', color: SECONDARY }), 'end'),
      spacer(),
      rangeBar(d, lo, hi, i === 0 ? model.current.temp : null),
      spacer(),
      fixed(32, text(fmtTemp(d.max), 14, { weight: 'medium' }), 'end'),
    ], { height: 21 });
  });
}

function rainSummary(model) {
  const m = model.minutely;
  const wet = /RAIN|SNOW/.test(model.current.skycon || '');
  return m.summary && (m.soon || wet) ? m.summary : null;
}

function large(model) {
  // 0、4、…、24 共 7 列，覆盖完整的未来 24 小时。
  const sampled = model.hours.filter((_, i) => i % 4 === 0).slice(0, 7);
  const summary = rainSummary(model);
  return [
    header(model),
    ...(summary ? [spacer(2), text(summary, 12, { color: SECONDARY })] : []),
    spacer(),
    hourColumns(model, sampled),
    spacer(),
    divider(),
    spacer(4),
    ...dayRows(model),
  ];
}

function accessoryCircular(model) {
  const c = sky(model.current.skycon);
  return col([
    icon(c.icon, 18),
    text(fmtTemp(model.current.temp), 16, { weight: 'semibold' }),
    text(`${fmtTemp(model.days[0] && model.days[0].min)}/${fmtTemp(model.days[0] && model.days[0].max)}`, 9),
  ], { alignItems: 'center', flex: 1 });
}

function accessoryRectangular(model) {
  const c = sky(model.current.skycon);
  return [
    text(model.city, 13, { weight: 'semibold' }),
    row([icon(c.icon, 14), spacer(4), text(`${fmtTemp(model.current.temp)} ${c.text}`, 14, { weight: 'medium' })]),
    text(rainSummary(model) || hiLo(model.days[0]), 12, { opacity: 0.8 }),
  ];
}

function accessoryInline(model) {
  const c = sky(model.current.skycon);
  return row([icon(c.icon, 14), spacer(3), text(`${fmtTemp(model.current.temp)} ${c.text}`, 14)]);
}

function refreshAt(nowMs, minutes) {
  return new Date(nowMs + minutes * 60 * 1000).toISOString();
}

function render(family, model, nowMs, refreshMin) {
  const refreshAfter = refreshAt(nowMs, refreshMin);
  if (family === 'accessoryCircular') return { type: 'widget', refreshAfter, children: [accessoryCircular(model)] };
  if (family === 'accessoryRectangular') return { type: 'widget', refreshAfter, gap: 1, children: accessoryRectangular(model) };
  if (family === 'accessoryInline') return { type: 'widget', refreshAfter, children: [accessoryInline(model)] };

  const backgroundGradient = background(model);
  if (family === 'systemLarge' || family === 'systemExtraLarge') {
    return { type: 'widget', refreshAfter, backgroundGradient, padding: 16, children: large(model) };
  }
  if (family === 'systemMedium') {
    return { type: 'widget', refreshAfter, backgroundGradient, padding: 16, children: medium(model) };
  }
  return { type: 'widget', refreshAfter, backgroundGradient, padding: 16, children: small(model) };
}

function renderError(family, err, nowMs) {
  const title = err.title || '暂时无法获取天气';
  const detail = err.detail || '请稍后再试';
  const refreshAfter = refreshAt(nowMs, REFRESH_FAIL_MIN);
  if (family === 'accessoryInline') return { type: 'widget', refreshAfter, children: [text(title, 14)] };
  if (family === 'accessoryCircular') {
    return { type: 'widget', refreshAfter, children: [col([icon('exclamationmark.triangle.fill', 20)], { alignItems: 'center', flex: 1 })] };
  }
  if (family === 'accessoryRectangular') {
    return { type: 'widget', refreshAfter, children: [text(title, 13, { weight: 'semibold' }), text(detail, 12, { opacity: 0.8 })] };
  }
  const t = THEMES.cloudy.day;
  return {
    type: 'widget',
    refreshAfter,
    padding: 16,
    backgroundGradient: { type: 'linear', colors: t, stops: [0, 0.55, 1], startPoint: { x: 0.5, y: 0 }, endPoint: { x: 0.5, y: 1 } },
    children: [
      icon('exclamationmark.triangle.fill', 22),
      spacer(),
      text(title, 16, { weight: 'semibold' }),
      spacer(3),
      { ...text(detail, 13, { color: SECONDARY }), maxLines: 2 },
    ],
  };
}

function clockLabel(ms, tzshift) {
  return `${new Date(ms + tzshift * 1000).toISOString().slice(11, 16)}更新`;
}

export default async function (ctx) {
  const family = ctx.widgetFamily || 'systemMedium';
  const nowMs = Date.now();
  const env = ctx.env || {};
  const token = (env.CAIYUN_TOKEN || '').trim();
  const city = (env.CITY || '').trim();

  if (!token) return renderError(family, fail('缺少 Token', '请配置 CAIYUN_TOKEN'), nowMs);
  if (!city) return renderError(family, fail('缺少城市', '请配置 CITY'), nowMs);

  const cacheKey = `weather:${city}`;
  try {
    const place = await resolveCity(ctx, city);
    const data = await fetchWeather(ctx, token, place);
    const model = normalize(ctx, city, place, data);
    storeSet(ctx, cacheKey, { savedAt: nowMs, model });
    return render(family, { ...model, nowMs }, nowMs, REFRESH_OK_MIN);
  } catch (err) {
    const cached = storeGet(ctx, cacheKey);
    if (cached && cached.model && nowMs - cached.savedAt < MAX_STALE_MS) {
      const model = {
        ...rollForward(cached.model, nowMs),
        nowMs,
        staleSince: clockLabel(cached.savedAt, cached.model.tzshift),
      };
      return render(family, model, nowMs, REFRESH_FAIL_MIN);
    }
    return renderError(family, err, nowMs);
  }
}
