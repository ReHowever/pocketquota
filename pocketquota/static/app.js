const $ = (s, r = document) => r.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const fmt = (cents) =>
  (Number(cents || 0) / 100).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const yuan = (cents) => `¥${fmt(cents)}`;
const pools = { daily: "日常池", flex: "灵活池", reserve: "固定池" };
const kinds = {
  expense: "支出",
  legacy_expense: "历史支出 · 未重复扣款",
  income: "收入",
  transfer: "转账",
  opening: "期初",
  settlement: "结余划转",
  coverage: "承担额修正",
  adjustment: "余额调整",
  reversal: "撤销",
  scheduled_income: "自动入账",
};
const paths = {
  home: "M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z",
  ledger: "M5 3h14v18H5zM8 7h8M8 11h8M8 15h5",
  review: "M9 3H5v18h14V3h-4M9 2h6v4H9zM8 12l3 3 5-6",
  rules: "M4 7h16M4 17h16M8 4v6M16 14v6",
  agents: "M8 8 4 12l4 4m8-8 4 4-4 4M14 4l-4 16",
  plus: "M12 5v14M5 12h14",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  wallet: "M3 5h17v15H3zM20 10h-6v6h6M5 5V3h12v2",
};
const icon = (n) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[n] || paths.wallet}"/></svg>`;
const brand = `<div class="brand"><img src="/icon.svg" alt="">PocketQuota<small class="sr-only">口袋额度</small></div>`;
let state = {
  page: "home",
  csrf: null,
  session: null,
  d: null,
  entries: [],
  schedules: [],
  reviews: [],
  tokens: [],
  notifications: [],
  rules: [],
  offset: 0,
  start: "",
  end: "",
};
let appearance = {
  theme: "dark",
  shape: "linear",
  palette: "aurora",
  metric: "daily",
  motion: true,
};
try {
  appearance = {
    ...appearance,
    ...JSON.parse(localStorage.getItem("pq-appearance") || "{}"),
  };
} catch {}
function applyAppearance() {
  document.documentElement.dataset.theme = appearance.theme;
  document.documentElement.dataset.palette = appearance.palette;
  document.documentElement.dataset.shape = appearance.shape;
  document.documentElement.dataset.motion = appearance.motion ? "on" : "off";
}
applyAppearance();
let refreshTimer, countTimer;
let refreshEpoch = 0;
async function api(path, body, key) {
  const headers = {};
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["X-CSRF-Token"] = state.csrf || "";
    headers["Idempotency-Key"] = key || crypto.randomUUID();
  }
  const r = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || `请求失败 (${r.status})`);
  return data;
}
let toastTimer;
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("show"), 4500);
}
function poolOptions(selected = "daily") {
  return Object.entries(pools)
    .map(
      ([k, v]) =>
        `<option value="${k}" ${k === selected ? "selected" : ""}>${v}</option>`,
    )
    .join("");
}
function field(label, name, value = "", type = "text", hint = "", extra = "") {
  return `<div class="field"><label for="f-${esc(name)}">${esc(label)}</label><input id="f-${esc(name)}" name="${esc(name)}" type="${type}" value="${esc(value)}" ${extra}></div>`;
}
function select(label, name, options) {
  return `<div class="field"><label for="f-${name}">${label}</label><select id="f-${name}" name="${name}">${options}</select></div>`;
}
function formError(form, e) {
  if (form.isConnected) $(".form-error", form).textContent = e.message;
  else toast(e.message);
}
function attachForm(id, fn) {
  const form = $(id);
  if (!form) return;
  // Keep a single key across a transport retry; a changed payload gets a fresh key.
  let lastPayload = "",
    key = "";
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = $("[type=submit]", form);
    button.disabled = true;
    $(".form-error", form).textContent = "";
    const data = Object.fromEntries(new FormData(form));
    const raw = JSON.stringify(data);
    if (raw !== lastPayload) {
      key = crypto.randomUUID();
      lastPayload = raw;
    }
    try {
      await fn(data, key, form);
    } catch (err) {
      formError(form, err);
    } finally {
      button.disabled = false;
    }
  });
}
function modal(title, body) {
  $("#dialog-content").innerHTML =
    `<div class="dialog-title"><h2>${title}</h2><button id="close-dialog" aria-label="关闭">×</button></div>${body}`;
  $("#close-dialog").onclick = () => $("#dialog").close();
  $("#dialog").showModal();
}
function footer(label = "保存") {
  return `<div class="form-error" role="alert"></div><div class="form-footer"><button type="submit" class="primary">${label}</button></div>`;
}
async function login() {
  clearInterval(refreshTimer);
  clearInterval(countTimer);
  Object.assign(state, {
    page: "home",
    d: null,
    entries: [],
    reviews: [],
    tokens: [],
    users: [],
    notifications: [],
    rules: [],
    offset: 0,
    start: "",
    end: "",
  });
  document.body.classList.remove("bankrupt");
  const info = await api("/api/info");
  $("#app").innerHTML =
    `<main class="login">${brand}<h1>登录</h1><form id="login-form">${field("账号", "username", "admin", "text", "", 'required autocomplete="username"')}${field("密码", "password", "", "password", "", 'required autocomplete="current-password"')}<div class="form-error" role="alert"></div><button class="primary" type="submit">进入我的账本 ${icon("arrow")}</button></form>${info.demo ? '<button id="demo-login" class="secondary">试用演示账本 · 全部为虚构数据</button>' : ""}<p class="tagline"><a href="/guide.html" target="_blank" rel="noopener">使用指南 ↗</a></p></main>`;
  attachForm("#login-form", async (data) => {
    const result = await api("/api/login", data);
    state.csrf = result.csrf;
    await start();
  });
  if (info.demo)
    $("#demo-login").onclick = async () => {
      try {
        const result = await api("/api/demo-session", {});
        state.csrf = result.csrf;
        await start();
      } catch (e) {
        toast(e.message);
      }
    };
}
async function start() {
  state.session = await api("/api/session");
  state.csrf = state.session.csrf;
  await refresh();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (!$("#dialog").open && state.page === "home") refresh().catch(() => {});
  }, 30000);
}
async function refresh(animate = true) {
  const epoch = ++refreshEpoch;
  const previousBalances = state.d?.initialized ? { ...state.d.balances } : null;
  const prior = state.d?.initialized ? gaugeData() : null;
  const priorPool = state.d?.initialized ? dailyPoolGauge() : null;
  const dashboard = await api("/api/dashboard");
  if (epoch !== refreshEpoch) return;
  if (!dashboard.initialized) { state.d = dashboard; return setup(); }
  const [entries, schedules, reviews, notifications, rules] = await Promise.all(
    [
      api(
        `/api/entries?limit=30&offset=${state.offset}${state.start ? "&start=" + state.start : ""}${state.end ? "&end=" + state.end : ""}`,
      ),
      api("/api/schedules"),
      api("/api/reviews"),
      api("/api/notifications"),
      api("/api/rules"),
    ],
  );
  if (epoch !== refreshEpoch) return;
  Object.assign(state, {
    d: dashboard,
    entries: entries.items,
    total: entries.total,
    schedules,
    reviews,
    notifications,
    rules,
  });
  if (state.page === "agents") state.tokens = await api("/api/tokens");
  if (state.page === "account" && state.session.site_admin)
    state.users = await api("/api/users");
  if (epoch !== refreshEpoch) return;
  render();
  updatePoolArtwork(previousBalances);
  const currentGauge = gaugeData();
  if (animate && prior && currentGauge.remaining !== prior.remaining)
    playQuotaEffect(currentGauge.remaining > prior.remaining ? "income" : "expense", prior);
  else if (animate && priorPool && dailyPoolGauge().balance !== priorPool.balance)
    playQuotaEffect(dailyPoolGauge().balance > priorPool.balance ? "income" : "expense", priorPool, true);
}
function appearanceModal() {
  modal(
    "定制你的额度界面",
    `<form id="appearance-form"><div class="form-grid">${select("界面主题", "theme", '<option value="dark">深空黑</option><option value="light">极简白</option>')}${select("额度条形态", "shape", '<option value="linear">光轨 · 线形额度条</option><option value="ring">轨道 · 圆环额度条</option>')}${select("光谱配色", "palette", '<option value="aurora">极光 · 紫蓝渐变</option><option value="blue">离子 · 冰蓝</option><option value="ember">日珥 · 橙金</option>')}${select("主额度条显示", "metric", '<option value="daily">今日可用额度</option><option value="total">总可消费预算</option>')}<label class="switch full"><input name="motion" type="checkbox" ${appearance.motion ? "checked" : ""}>启用光轨、水波与保险柜动效</label></div>${footer("应用外观")}</form>`,
  );
  for (const k of ["theme", "shape", "palette", "metric"])
    $("[name=" + k + "]", $("#appearance-form")).value = appearance[k];
  attachForm("#appearance-form", async (data, _key, form) => {
    appearance = { ...data, motion: $("[name=motion]", form).checked };
    localStorage.setItem("pq-appearance", JSON.stringify(appearance));
    applyAppearance();
    $("#dialog").close();
    render();
    toast("外观已更新");
  });
}
function gaugeData() {
  const d = state.d;
  const total = appearance.metric === "total";
  const remaining = total ? Math.max(0, d.spendable) : Math.max(0, d.remaining);
  const cap = total ? d.spendable_capacity : d.rule.daily_limit;
  return {
    remaining,
    cap,
    percent: cap ? Math.min(100, Math.max(0, (remaining / cap) * 100)) : 0,
  };
}
function dailyPoolGauge() {
  const pool = state.d.daily_pool;
  const balance = pool?.balance ?? state.d.balances.daily;
  const cap = pool?.funded ?? Math.max(0, balance);
  return { remaining: Math.max(0, balance), balance, cap,
    percent: cap ? Math.max(0, Math.min(100, balance / cap * 100)) : 0 };
}
function gauge() {
  const g = gaugeData(), p = dailyPoolGauge();
  const label = appearance.metric === "total" ? "总可消费预算" : "今日可用额度";
  if (appearance.shape === "ring")
    return `<div class="orbit-layout dual-orbit-layout"><div class="quota-orbit" id="quota-gauge" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${g.percent}"><svg viewBox="0 0 180 180" aria-hidden="true"><defs><linearGradient id="orbit-gradient"><stop offset="0%" class="orbit-stop-a"/><stop offset="100%" class="orbit-stop-b"/></linearGradient><linearGradient id="pool-orbit-gradient"><stop offset="0%" stop-color="#51d4c4"/><stop offset="100%" stop-color="#91e8d9"/></linearGradient></defs><circle class="orbit-track" cx="90" cy="90" r="76"/><circle class="orbit-fill" cx="90" cy="90" r="76" stroke-dasharray="477.522" stroke-dashoffset="${477.522 * (1 - g.percent / 100)}"/><circle class="orbit-track pool-orbit-track" cx="90" cy="90" r="56"/><circle class="pool-orbit-fill" cx="90" cy="90" r="56" stroke-dasharray="351.858" stroke-dashoffset="${351.858 * (1 - p.percent / 100)}"/></svg><div class="orbit-center"><strong>${g.percent.toFixed(1)}<small>%</small></strong></div></div><div class="orbit-caption dual-caption"><div class="gauge-caption"><span class="gauge-name"><i class="gauge-key"></i>${label}</span><strong>${yuan(g.remaining)}</strong><small>OF ${yuan(g.cap)}</small></div><div class="gauge-caption pool-caption" role="progressbar" aria-label="日常池总余额" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p.percent}" aria-valuetext="${yuan(p.balance)}，累计入池 ${yuan(p.cap)}"><span class="gauge-name"><i class="gauge-key pool-key"></i>日常池总余额</span><strong>${yuan(p.balance)}</strong><small>${p.percent.toFixed(1)}% · OF ${yuan(p.cap)}</small></div></div></div>`;
  return `<div class="dual-lines"><div class="quota-lane"><div class="progress-info"><span>${label}</span><strong>${yuan(g.remaining)} <small>/ ${yuan(g.cap)}</small></strong></div><div class="quota-track" id="quota-gauge" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${g.percent}"><div class="quota-fill" data-width="${g.percent}"><span class="fill-sheen"></span></div><div class="track-ticks" aria-hidden="true"></div></div></div><div class="quota-lane pool-lane"><div class="progress-info"><span>日常池总余额</span><strong>${yuan(p.balance)} <small>/ ${yuan(p.cap)}</small></strong></div><div class="quota-track" id="daily-pool-gauge" role="progressbar" aria-label="日常池总余额" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p.percent}" aria-valuetext="${yuan(p.balance)}，累计入池 ${yuan(p.cap)}"><div class="pool-quota-fill" data-width="${p.percent}"></div><div class="track-ticks" aria-hidden="true"></div></div></div></div>`;
}
function playQuotaEffect(type, prior, poolMode = false) {
  if (
    !appearance.motion ||
    matchMedia("(prefers-reduced-motion: reduce)").matches ||
    state.page !== "home"
  )
    return;
  const gauge = $(poolMode && appearance.shape !== "ring" ? "#daily-pool-gauge" : "#quota-gauge"),
    canvas = $("#quota-fx");
  if (!gauge || !canvas) return;
  const card = canvas.parentElement.getBoundingClientRect(),
    rect = gauge.getBoundingClientRect();
  const dpr = Math.min(Math.max(devicePixelRatio, 1), 3);
  canvas.width = Math.round(card.width * dpr);
  canvas.height = Math.round(card.height * dpr);
  canvas.style.width = card.width + "px";
  canvas.style.height = card.height + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const style = getComputedStyle(gauge);
  const colors = [
    poolMode ? "#51d4c4" : style.getPropertyValue("--accent").trim(),
    poolMode ? "#91e8d9" : style.getPropertyValue("--accent2").trim(),
    "#c7e4ff",
    appearance.theme === "light" ? "#7464d7" : "#ffffff",
  ];
  // Rasterize soft halos once; no expensive per-particle shadow blur in the frame loop.
  const sprites = colors.map((color) => {
    const sprite = document.createElement("canvas");
    sprite.width = sprite.height = Math.round(40 * dpr);
    const sc = sprite.getContext("2d");
    sc.scale(dpr, dpr);
    const glow = sc.createRadialGradient(20, 20, 0, 20, 20, 20);
    glow.addColorStop(0, color);
    glow.addColorStop(0.12, color + "bb");
    glow.addColorStop(0.45, color + "30");
    glow.addColorStop(1, color + "00");
    sc.fillStyle = glow;
    sc.fillRect(0, 0, 40, 40);
    return sprite;
  });
  const g = poolMode ? dailyPoolGauge() : gaugeData(),
    income = type === "income",
    cx = rect.left - card.left + rect.width / 2,
    cy = rect.top - card.top + rect.height / 2;
  const oldPct = prior?.percent ?? g.percent;
  const low = Math.min(oldPct, g.percent) / 100,
    high = Math.max(oldPct, g.percent) / 100;
  const fill = $(poolMode ? ".pool-quota-fill" : ".quota-fill", gauge),
    arc = $(poolMode ? ".pool-orbit-fill" : ".orbit-fill", gauge);
  const circumference = poolMode ? 351.858 : 477.522;
  if (fill) {
    fill.style.transition = "none";
    fill.style.width = oldPct + "%";
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        fill.style.transition = "";
        fill.style.width = g.percent + "%";
      }),
    );
  }
  if (arc) {
    arc.style.transition = "none";
    arc.style.strokeDashoffset = circumference * (1 - oldPct / 100);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        arc.style.transition = "";
        arc.style.strokeDashoffset = circumference * (1 - g.percent / 100);
      }),
    );
  }
  const count = Math.round((income ? 88 : 68) * (card.width < 420 ? 0.75 : 1));
  const particles = Array.from({ length: count }, (_, i) => {
    let x, y;
    if (appearance.shape === "ring") {
      const a =
        -Math.PI / 2 +
        (low + Math.random() * Math.max(0.025, high - low)) * Math.PI * 2;
      x = cx + Math.cos(a) * rect.width * (poolMode ? 0.311 : 0.422);
      y = cy + Math.sin(a) * rect.height * (poolMode ? 0.311 : 0.422);
    } else {
      x =
        rect.left -
        card.left +
        rect.width * (low + Math.random() * Math.max(0.025, high - low));
      y = cy + (Math.random() - 0.5) * 12;
    }
    return {
      x,
      y,
      vx: (Math.random() - 0.5) * 130,
      vy: -(20 + Math.random() * 75),
      size: 0.8 + Math.random() * 1.6,
      color: colors[i % colors.length],
      sprite: sprites[i % sprites.length],
      delay: Math.random() * 180,
      life: 850 + Math.random() * 500,
      phase: Math.random() * Math.PI * 2,
      previous: null,
    };
  });
  const start = performance.now();
  let frames = 0;
  canvas.dataset.phase = "running";
  function frame(now) {
    if (!canvas.isConnected || document.hidden) return;
    const elapsed = now - start;
    ctx.clearRect(0, 0, card.width, card.height);
    if (elapsed > 1600) {
      canvas.dataset.phase = "complete";
      canvas.dataset.frames = String(frames);
      canvas.dataset.durationMs = String(Math.round(elapsed));
      return;
    }
    frames += 1;
    ctx.globalCompositeOperation =
      appearance.theme === "light" ? "source-over" : "lighter";
    for (const p of particles) {
      const age = (elapsed - p.delay) / p.life;
      if (age < 0 || age > 1) continue;
      const eased = 1 - Math.pow(1 - age, 3);
      const f = income ? 1 - eased : eased;
      const x = p.x + p.vx * f + Math.sin(age * 4 + p.phase) * 5 * f;
      const y = p.y + p.vy * f + (income ? 0 : 24 * age * age);
      const alpha = Math.sin(Math.PI * Math.pow(age, 0.6)) * 0.9;
      const radius = p.size * (income ? 0.8 + 0.2 * eased : 1 - 0.55 * age);
      if (p.previous) {
        ctx.globalAlpha = alpha * 0.35;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = radius * 0.7;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(p.previous.x, p.previous.y);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
      ctx.globalAlpha = alpha * 0.65;
      ctx.drawImage(
        p.sprite,
        x - radius * 5,
        y - radius * 5,
        radius * 10,
        radius * 10,
      );
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      if (income) {
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(x - radius / 2, y - radius / 2, radius, radius);
      }
      p.previous = { x, y };
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  gauge.classList.remove("credit-flash", "debit-flash");
  gauge.classList.add(income ? "credit-flash" : "debit-flash");
  setTimeout(() => gauge.classList.remove("credit-flash", "debit-flash"), 1200);
}
function setup() {
  $("#app").innerHTML =
    `<main class="setup">${brand}<h1>从一个真实的起点开始</h1><p>填写你现在准备分配的金额。这是预算分配，不会连接银行，也不会移动真实资金。</p><form id="setup-form"><div class="form-grid">${field("账本名称", "name", "我的生活额度")}${field("每日限额（元）", "daily_limit", "60.00", "number", "", 'min="0" step="0.01" required')}${field("日常池（元）", "daily", "0.00", "number", "", 'min="0" step="0.01" required')}${field("灵活池（元）", "flex", "0.00", "number", "", 'min="0" step="0.01" required')}${field("固定池（元）", "reserve", "0.00", "number", "不会自动用于补足日常支出", 'min="0" step="0.01" required')}${field("每天结算时间", "settle_time", "21:00", "time")}${field("时区", "timezone", "Asia/Shanghai", "text", "初始化后固定，避免同一天重复结算")}</div>${footer("建立我的账本")}</form></main>`;
  attachForm("#setup-form", async (data, key) => {
    await api("/api/setup", data, key);
    await refresh();
  });
}
const navItems = [
  ["home", "额度总览"],
  ["ledger", "收支流水"],
  ["review", "对账中心"],
  ["rules", "预算与规则"],
  ["agents", "Agent 接入"],
  ["account", "账号"],
];
function render() {
  clearInterval(countTimer);
  const d = state.d;
  document.body.classList.toggle("bankrupt", d.bankrupt);
  $("#app").innerHTML =
    `<div class="shell"><aside class="sidebar">${brand}<div class="nav-label">PERSONAL CONSOLE</div><nav class="nav" aria-label="主导航">${navItems.map(([id, label]) => `<button data-nav="${id}" class="${id === state.page ? "active" : ""}" ${id === state.page ? 'aria-current="page"' : ""}>${icon(id)}${label}</button>`).join("")}</nav><div class="side-foot"><span>自托管 · v0.3.1</span><span>◉</span></div></aside><main class="workspace"><header class="topbar"><div class="ledger-name" title="${esc(d.settings.name)}">${esc(d.settings.name)}</div><div class="top-actions"><span class="hide-mobile">${esc(d.today)} · ${esc(d.settings.timezone)}</span><span><i class="status-dot"></i>${state.session.demo ? "演示数据" : "私人账本"}</span><a class="guide-link" href="/guide.html" target="_blank" rel="noopener">指南 ↗</a><button class="appearance-button" id="appearance" title="主题、配色与额度条">◐ <span>外观</span></button><button class="ghost" id="refresh" title="刷新">↻</button><button class="avatar" id="account-avatar" aria-label="账号设置">${esc((state.session.username || "P").slice(0, 1).toUpperCase())}</button></div></header><div id="page">${{ home: home, ledger: ledger, review: review, rules: rules, agents: agents, account: account }[state.page]()}</div></main></div>`;
  document.querySelectorAll("[data-nav]").forEach(
    (b) =>
      (b.onclick = async () => {
        state.page = b.dataset.nav;
        state.offset = 0;
        await refresh().catch((e) => toast(e.message));
      }),
  );
  $("#appearance").onclick = appearanceModal;
  $("#refresh").onclick = () =>
    refresh()
      .then(() => toast("已刷新"))
      .catch((e) => toast(e.message));
  $("#account-avatar").onclick = async () => {
    state.page = "account";
    await refresh();
  };
  document
    .querySelectorAll("[data-add]")
    .forEach((b) => (b.onclick = () => entryModal(b.dataset.add)));
  bindPage();
  bindAccount();
  updateCountdown();
  countTimer = setInterval(updateCountdown, 1000);
}
function title(eye, name, description, action = "") {
  return `<div class="page-title"><div><h1>${name}</h1></div>${action}</div>`;
}
function addButton() {
  return `<button class="primary" data-add="expense">${icon("plus")} 记一笔</button>`;
}
function bankruptcy() {
  const d = state.d;
  return d.bankrupt
    ? `<section class="bankruptcy" role="alert"><h2>赤字 · 已破产</h2><div class="deficit">可消费余额 ${yuan(d.spendable)}</div><span class="badge">${state.notifications.length ? "通知待投递" : "已通知"}</span></section>`
    : "";
}
function txList(items) {
  return items.length
    ? items
        .map((r) => {
          const expense = ["expense", "legacy_expense"].includes(r.kind);
          const positive = ["income", "scheduled_income", "opening"].includes(
            r.kind,
          );
          return `<div class="transaction"><div class="tx-symbol">${expense ? "↗" : positive ? "↙" : "⇄"}</div><div class="tx-main"><strong>${esc(r.note || r.category || kinds[r.kind])}</strong><small>${esc(r.date)} · ${esc(pools[r.pool])} · ${r.actor.startsWith("agent:") ? "Agent" : r.actor === "scheduler" ? "自动规则" : "手动"}${r.reversed ? " · 已撤销" : ""}</small></div><div class="tx-amount ${positive ? "income" : ""}">${expense ? "−" : positive ? "+" : ""}${yuan(r.amount)}<small>${esc(kinds[r.kind])}</small></div></div>`;
        })
        .join("")
    : '<div class="empty">暂无流水</div>';
}
// Pool artwork is decorative. All displayed amounts come from the ledger.
function poolArtwork() {
  const d = state.d;
  const controls = (p) => `<div class="pool-controls"><button class="secondary" data-pool-move="${p}" data-direction="in" aria-label="存入${pools[p]}">${icon("plus")}存入</button><button class="secondary" data-pool-move="${p}" data-direction="out" aria-label="从${pools[p]}取出">${icon("arrow")}取出</button><button class="ghost" data-adjust="${p}" aria-label="修改${pools[p]}余额">改余额</button></div>`;
  return `<section class="savings-grid" aria-label="蓄水池与保险柜">
    <article class="savings-card reservoir-card ${d.balances.flex <= 0 ? "reservoir-dry" : ""} ${fmt(d.balances.flex).length > 9 ? "long-balance" : ""} ${d.balances.flex < 0 ? "pool-deficit" : ""}" data-pool-card="flex">
      <header class="savings-heading"><div><span class="savings-eyebrow">FLEX RESERVOIR</span><h2>灵活池<span>蓄水池</span></h2></div><button class="pool-amount" data-adjust="flex" aria-label="修改灵活池余额">${yuan(d.balances.flex)}<span aria-hidden="true">↗</span></button></header>
      <div class="reservoir-art" role="img" aria-label="灵活池蓄水，当前余额${yuan(d.balances.flex)}">
        <div class="reservoir-glass"><div class="reservoir-lines" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
          <div class="reservoir-water"><svg class="water-wave wave-back" viewBox="0 0 600 32" preserveAspectRatio="none" aria-hidden="true"><path d="M0 16Q75 0 150 16T300 16T450 16T600 16V32H0Z"/></svg><svg class="water-wave wave-front" viewBox="0 0 600 32" preserveAspectRatio="none" aria-hidden="true"><path d="M0 16Q75 0 150 16T300 16T450 16T600 16V32H0Z"/></svg><span class="water-shine" aria-hidden="true"></span></div>
          <div class="water-droplets" aria-hidden="true"><i></i><i></i><i></i></div><span class="reservoir-caption">${d.balances.flex < 0 ? "余额不足，等待补充" : d.balances.flex === 0 ? "从第一滴开始积累" : "一点一滴，留住余裕"}</span>
        </div><span class="pool-change" aria-live="polite"></span>
      </div>
      <p class="pool-description">${d.rule.carry_over ? "每日结余自动汇入，水位随余额起落。" : "存入慢慢积累，取出留给需要的时候。"}</p>${controls("flex")}
    </article>
    <article class="savings-card vault-card ${d.balances.reserve <= 0 ? "vault-empty" : ""} ${fmt(d.balances.reserve).length > 9 ? "long-balance" : ""} ${d.balances.reserve < 0 ? "pool-deficit" : ""}" data-pool-card="reserve">
      <header class="savings-heading"><div><span class="savings-eyebrow">RESERVE VAULT</span><h2>固定池<span>保险柜</span></h2></div><button class="pool-amount" data-adjust="reserve" aria-label="修改固定池余额">${yuan(d.balances.reserve)}<span aria-hidden="true">↗</span></button></header>
      <div class="vault-art" role="img" aria-label="固定池保险柜，当前余额${yuan(d.balances.reserve)}"><div class="vault-scene" aria-hidden="true"><div class="vault-base"></div><div class="vault-shell"><div class="vault-interior"><i class="vault-note note-one"></i><i class="vault-note note-two"></i><i class="vault-note note-three"></i></div><div class="vault-door"><span class="vault-led"></span><span class="vault-wheel"><i></i><i></i><i></i></span><span class="vault-hinge hinge-top"></span><span class="vault-hinge hinge-bottom"></span><span class="vault-door-caption">RESERVE</span></div></div><i class="vault-moving-note"></i></div><span class="pool-change" aria-live="polite"></span></div>
      <p class="pool-description">固定留存，手动取用；不会自动补足日常消费。</p>${controls("reserve")}
    </article>
  </section>`;
}

function reservoirLevel(cents) {
  // A monotone decorative mapping, not a percentage of an invented savings target.
  const amount = Math.max(0, Number(cents) || 0);
  return amount === 0 ? 0 : Math.min(92, Math.max(5, (amount / (amount + 10000)) * 100));
}

function updatePoolArtwork(previousBalances) {
  const moving = appearance.motion && !matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.querySelectorAll("[data-pool-card]").forEach((card) => {
    const pool = card.dataset.poolCard;
    const current = state.d.balances[pool];
    const old = previousBalances?.[pool];
    const water = $(".reservoir-water", card);
    if (water) {
      const finalTransform = `translateY(${100 - reservoirLevel(current)}%)`;
      water.style.transform = finalTransform;
      card.style.setProperty("--wave-phase", `${-(Date.now() % 6000) / 1000}s`);
      if (moving && old !== undefined && old !== current) {
        water.animate([
          { transform: `translateY(${100 - reservoirLevel(old)}%)`, opacity: old > 0 ? 0.85 : 0, offset: 0 },
          { transform: `translateY(${Math.max(0, Math.min(100, 100 - reservoirLevel(current) + (current > old ? -1.5 : 1.5)))}%)`, opacity: current > 0 ? 0.85 : 0.12, offset: 0.8 },
          { transform: finalTransform, opacity: current > 0 ? 0.85 : 0, offset: 1 },
        ], { duration: 1300, easing: "cubic-bezier(.22,1,.36,1)" });
      }
    }
    if (old === undefined || old === current) return;
    const delta = current - old;
    const change = $(".pool-change", card);
    change.textContent = `${delta > 0 ? "+" : "−"}${yuan(Math.abs(delta))}`;
    card.dataset.flow = delta > 0 ? "in" : "out";
    if (moving) card.classList.add("pool-changing");
    else change.classList.add("change-static");
    setTimeout(() => {
      if (!card.isConnected) return;
      card.classList.remove("pool-changing");
      change.classList.remove("change-static");
      change.textContent = "";
      delete card.dataset.flow;
    }, 2300);
  });
}

function poolMoveModal(target, direction) {
  const incoming = direction === "in";
  const options = Object.entries(pools).filter(([key]) => key !== target)
    .map(([key, name]) => `<option value="${key}">${name}</option>`).join("") +
    `<option value="external">${incoming ? "外部收入 · 新增资金" : "实际支出 · 离开账本"}</option>`;
  modal((incoming ? "存入" : "取出") + pools[target],
    `<form id="pool-move-form"><div class="pool-form-balance"><span>当前${pools[target]}</span><strong>${yuan(state.d.balances[target])}</strong></div><div class="form-grid">${field("金额（元）", "amount", "", "number", "", 'min="0.01" step="0.01" required autofocus')}${select(incoming ? "资金来源" : "转入位置", "counterparty", options)}<div class="full">${field("备注", "note", "", "text", "", 'maxlength="240"')}</div></div><p class="pool-move-preview" id="pool-move-preview" aria-live="polite">选择金额后显示变动。</p><p class="subtle">资金池之间转入转出不计为消费；只有选择实际支出才计入支出。</p>${footer(incoming ? "确认存入" : "确认取出")}</form>`);
  const preview = () => {
    const raw = $("#f-amount").value;
    const cents = /^\d+(\.\d{1,2})?$/.test(raw) ? Math.round(Number(raw) * 100) : null;
    const partner = $("#f-counterparty").value;
    const value = $("#pool-move-preview");
    if (cents === null || cents <= 0) { value.textContent = "输入金额后显示变动。"; return; }
    const after = state.d.balances[target] + (incoming ? cents : -cents);
    const otherAfter = partner === "external" ? null : state.d.balances[partner] + (incoming ? -cents : cents);
    value.textContent = `${pools[target]} ${yuan(state.d.balances[target])} → ${yuan(after)}` +
      (otherAfter === null ? "" : `；${pools[partner]} → ${yuan(otherAfter)}`);
    value.classList.toggle("warning", after < 0 || (otherAfter !== null && otherAfter < 0));
  };
  $("#f-amount").addEventListener("input", preview);
  $("#f-counterparty").addEventListener("change", preview);
  attachForm("#pool-move-form", async (data, key) => {
    const external = data.counterparty === "external";
    const payload = { amount: data.amount, date: state.d.today,
      kind: external ? (incoming ? "income" : "expense") : "transfer",
      pool: external ? target : incoming ? data.counterparty : target,
      note: data.note || `${incoming ? "存入" : "取出"}${pools[target]}` };
    if (!external) payload.to_pool = incoming ? target : data.counterparty;
    await api("/api/entries", payload, key);
    $("#dialog").close();
    await refresh();
    toast(`已${incoming ? "存入" : "取出"}${pools[target]} · ${yuan(Math.round(Number(data.amount) * 100))}`);
  });
}


function home() {
  const d = state.d;
  const percent = Math.max(0, Math.min(100, d.usage_percent || 0));
  return `${title("BUDGET OVERVIEW", "额度总览", "让消费有边界，让选择有余地。", addButton())}${bankruptcy()}<div class="overview-grid"><section class="quota"><canvas id="quota-fx" aria-hidden="true"></canvas><div class="card-top"><h2>${appearance.metric === "total" ? "总可消费预算" : "今日可用额度"}</h2><span class="live-dot" aria-label="已同步"></span></div>${appearance.shape === "linear" ? `<div class="big-amount"><small>¥</small>${fmt(gaugeData().remaining)}</div>${appearance.metric === "daily" && d.remaining < 0 ? `<span class="excess-tag">+${yuan(-d.remaining)}</span>` : ""}` : ""}${gauge()}<div class="reset-line"><span id="countdown"></span><span>${esc(d.settings.settle_time)}</span></div></section><section class="allocation"><div class="card-top"><h2>我的资金池</h2></div><div class="total">${yuan(d.spendable)}</div><div class="pool-lines">${Object.entries(
    pools,
  )
    .map(
      ([k, v]) =>
        `<div class="pool-line"><span><i class="dot ${k}"></i>${v}</span><button class="pool-summary-amount" data-adjust="${k}" aria-label="修改${v}余额">${yuan(d.balances[k])}<span aria-hidden="true">↗</span></button></div>`,
    )
    .join(
      "",
    )}</div></section></div>${poolArtwork()}<div class="metrics"><div class="metric"><div class="metric-label">本月已支出 ${icon("wallet")}</div><div class="value">${yuan(d.month_expense)}</div></div><div class="metric"><div class="metric-label">${d.legacy_count ? "本月入账（新账本）" : "本月已入账"} ${icon("arrow")}</div><div class="value">${yuan(d.month_income)}</div></div><div class="metric"><div class="metric-label">${d.settled ? "今日结算状态" : "预计今日结余"} ${icon("clock")}</div><div class="value">${d.settled ? "已结算" : yuan(d.projected_carry)}</div></div></div><div class="lower-grid"><section class="panel"><div class="panel-heading"><h2>最近的消费与变动</h2><button class="ghost" id="view-ledger">查看全部 →</button></div><div class="ledger-list">${txList(state.entries.slice(0, 5))}</div></section><section class="panel"><div class="panel-heading"><h2>近 7 日额度使用</h2><small>日常消费</small></div><div class="chart">${d.trend.map((r, i) => `<div class="chart-col"><div class="chart-value">${r.spent ? fmt(r.spent) : "—"}</div><div class="bar-area"><div class="bar" data-height="${Math.max(3, (r.spent / Math.max(...d.trend.map((x) => Math.max(x.spent, x.limit)), 1)) * 108)}" title="${esc(r.date)}：${yuan(r.spent)}"></div></div><small>${i === 6 ? "今天" : r.date.slice(5).replace("-", "/")}</small></div>`).join("")}</div></section></div>${d.warnings.length ? `<div class="inline-callout red-callout">${d.warnings.map(esc).join("<br>")}</div>` : ""}`;
}
function ledger() {
  return `${title("TRANSACTION JOURNAL", "收支流水", "补记、撤销和自动划转都会保留记录。余额调整不会抹去历史。", addButton())}${state.d.legacy_count ? `<div class="inline-callout">已保留 ${state.d.legacy_count} 笔历史支出，不重复扣减当前余额。旧预算收入、调整与结算快照见 <a href="/api/legacy-export.json">迁移原始档案</a>。</div>` : ""}<section class="panel"><div class="panel-heading"><h2>收支流水 <small>共 ${state.total} 笔</small></h2><a class="secondary" href="/api/export.csv?start=${encodeURIComponent(state.start)}&amp;end=${encodeURIComponent(state.end)}">导出 CSV</a></div><form id="filter-form" class="filters"><label>起始 <input name="start" type="date" value="${esc(state.start)}"></label><label>截止 <input name="end" type="date" value="${esc(state.end)}"></label><button class="secondary" type="submit">筛选</button><button class="ghost" type="button" id="clear-filter">重置</button></form><p class="table-scroll-hint">左右滑动，查看完整流水和操作。</p><div class="table-wrap"><table><thead><tr><th>日期 / 来源</th><th>用途</th><th>金额</th><th>资金池 / 实际承担</th><th>操作</th></tr></thead><tbody>${state.entries
    .map(
      (r) =>
        `<tr><td>${esc(r.date)}<small>${r.actor.startsWith("agent:") ? "Agent" : esc(r.actor)}</small></td><td>${esc(r.note || r.category || kinds[r.kind])}<small>${esc(kinds[r.kind])} ${r.reversed ? "· 已撤销" : ""}</small></td><td class="mono">${yuan(r.amount)}</td><td><span class="badge">${esc(r.kind === "legacy_expense" ? "历史归档" : pools[r.pool])}</span>${
          r.kind === "expense"
            ? `<small>${Object.entries(r.postings)
                .filter(([k, v]) => k !== "external" && v < 0)
                .map(([k, v]) => esc(pools[k]) + " " + yuan(-v))
                .join(" + ")}</small>`
            : ""
        }</td><td>${["expense", "income", "transfer", "legacy_expense"].includes(r.kind) && !r.reversed ? `<button class="ghost warning" data-reverse="${r.id}">撤销</button>` : "—"}</td></tr>`,
    )
    .join(
      "",
    )}</tbody></table>${state.entries.length ? "" : '<div class="empty">这个日期范围没有流水。</div>'}</div><div class="pagination"><button class="secondary" id="prev-page" ${!state.offset ? "disabled" : ""}>上一页</button><span>${Math.floor(state.offset / 30) + 1} / ${Math.max(1, Math.ceil(state.total / 30))}</span><button class="secondary" id="next-page" ${state.offset + 30 >= state.total ? "disabled" : ""}>下一页</button></div></section>`;
}
function review() {
  return `${title("RECONCILIATION", "对账", "每日核对，每月回看。差异只会被记录，不会自动修改你的余额。", '<button class="primary" id="new-review">' + icon("plus") + " 开始对账</button>")}<div class="two-cols"><section class="panel"><div class="panel-heading"><h2>每天结算</h2><span class="pill">${state.d.settings.settle_time}</span></div><div class="inline-callout">${state.d.settled ? "已结算" : "未结算"}</div><button class="secondary" id="settle-today">结算今天</button></section><section class="panel"><div class="panel-heading"><h2>每月对账提醒</h2><span class="pill">每月 ${state.d.settings.review_day} 日</span></div><div class="inline-callout">${state.d.pending_reviews.length ? "待对账：" + state.d.pending_reviews.map(esc).join("、") : "暂无待对账"}</div></section></div><section class="panel section-gap"><h2>对账记录</h2>${
    state.reviews.length
      ? state.reviews
          .map(
            (r) =>
              `<article class="review-card"><div class="card-top"><h3>${esc(r.period)}</h3><span class="${r.stale ? "warning" : Object.values(r.difference).some(Boolean) ? "warning" : "success"}">${r.stale ? "历史发生补记，需复核" : Object.values(r.difference).some(Boolean) ? "存在差异" : "核对一致"}</span></div><div>${Object.entries(
                r.difference,
              )
                .map(([k, v]) => `${pools[k]}差额 ${yuan(v)}`)
                .join(
                  " · ",
                )}</div><small class="subtle">${esc(r.note || "无备注")} · ${esc(r.created_at.slice(0, 10))}</small></article>`,
          )
          .join("")
      : '<div class="empty">暂无记录</div>'
  }</section>`;
}
function rules() {
  const d = state.d;
  return `${title("BUDGET POLICIES", "预算与规则", "管理额度、结算和自动入账。所有金额变更都有审计记录。")}<div class="two-cols"><section class="panel"><div class="panel-heading"><h2>每日额度与对账时间</h2><span class="pill">${esc(d.settings.timezone)}</span></div><form id="settings-form"><div class="form-grid">${field("账本名称", "name", d.settings.name)}${field("每日限额（元）", "daily_limit", (d.rule.daily_limit / 100).toFixed(2), "number", "", 'min="0" step="0.01" required')}${field("额度生效日", "effective", d.today, "date", "历史规则保留，不追改往日额度", `min="${d.today}" required`)}${field("每日结算时间", "settle_time", d.settings.settle_time, "time", "", "required")}${field("每月对账日期", "review_day", d.settings.review_day, "number", "在此日提醒核对上个月", 'min="1" max="28" required')}${field("每月对账时间", "review_time", d.settings.review_time, "time", "", "required")}<label class="switch full"><input type="checkbox" name="carry_over" ${d.rule.carry_over ? "checked" : ""}> 当日未用额度自动划入灵活池</label></div>${footer("保存规则")}</form></section><section class="panel"><div class="panel-heading"><h2>资金池余额</h2><small>可手动调整</small></div>${Object.entries(
    pools,
  )
    .map(
      ([k, v]) =>
        `<div class="schedule-item"><div><strong>${v}</strong></div><div><strong>${yuan(d.balances[k])}</strong><small><button class="ghost" data-adjust="${k}">调整余额 →</button></small></div></div>`,
    )
    .join(
      "",
    )}</section></div><section class="panel section-gap"><div class="panel-heading"><h2>自动入账计划</h2><button class="secondary" id="new-schedule">＋ 添加计划</button></div>${state.schedules.length ? state.schedules.map((s) => `<div class="schedule-item"><div><strong>${esc(s.name)} <span class="badge">${s.enabled ? "已启用" : "已暂停"}</span></strong><small>${s.frequency === "daily" ? "每天" : "每月 " + s.day + " 日"} ${esc(s.time)} → ${pools[s.pool]} · ${yuan(s.amount)}${s.day > 28 ? "（短月在月末）" : ""}</small></div><button class="ghost" data-schedule="${s.id}">编辑 →</button></div>`).join("") : '<div class="empty">暂无计划</div>'}</section><section class="panel section-gap"><h2>额度规则历史</h2><div class="table-wrap"><table><thead><tr><th>生效日</th><th>每日额度</th><th>结余结转</th></tr></thead><tbody>${state.rules.map((r) => `<tr><td>${esc(r.effective)}</td><td>${yuan(r.data.daily_limit)}</td><td>${r.data.carry_over ? "开启" : "关闭"}</td></tr>`).join("")}</tbody></table></div></section>`;
}
function agents() {
  return `${title("AGENT CONNECTIONS", "Agent", "同一套账本，多个入口。只读查询、对话记账、通知领取，各有边界。", '<button class="primary" id="new-agent">' + icon("plus") + " 连接 Agent</button>")}<div class="two-cols"><section class="panel"><div class="panel-heading"><h2>访问凭据</h2><span class="pill">${esc(state.session.username)}</span></div>${state.tokens.length ? state.tokens.map((t) => `<div class="schedule-item"><div><strong>${esc(t.name)}</strong><small>${JSON.parse(t.scopes).includes("manage") ? "预算管理" : JSON.parse(t.scopes).includes("write") ? "查询 + 记账" : "仅查询"} · ${t.revoked ? "已撤销" : "有效"}</small></div>${!t.revoked ? `<button class="ghost warning" data-revoke="${t.id}">撤销</button>` : ""}</div>`).join("") : '<div class="empty">暂无连接</div>'}</section><section class="panel"><div class="panel-heading"><h2>额度通知</h2><span class="pill">${state.notifications.length} 条待处理</span></div>${state.notifications.map((n) => `<div class="inline-callout red-callout"><strong>赤字 · 已破产</strong><br>缺口 ${yuan(n.data.deficit)} · ${esc(n.created_at.slice(0, 10))}<br>待投递</div>`).join("") || '<div class="inline-callout">暂无通知</div>'}</section></div><section class="panel section-gap"><div class="panel-heading"><h2>接入方式</h2><a class="guide-link" href="/guide.html#agents" target="_blank" rel="noopener">指南 ↗</a></div><div class="connector-grid"><a href="/guide.html#agents" target="_blank" rel="noopener">MCP <span>↗</span></a><a href="/openapi.json" target="_blank" rel="noopener">REST <span>↗</span></a><a href="/guide.html#agents" target="_blank" rel="noopener">Codex <span>↗</span></a><a href="/guide.html#agents" target="_blank" rel="noopener">Claude <span>↗</span></a><a href="/guide.html#agents" target="_blank" rel="noopener">Cursor <span>↗</span></a><a href="/guide.html#agents" target="_blank" rel="noopener">Gemini <span>↗</span></a></div></section>`;
}
function updateCountdown() {
  const el = $("#countdown");
  if (!el || !state.d?.next_reset) return;
  const seconds = Math.max(
    0,
    Math.floor((new Date(state.d.next_reset) - Date.now()) / 1000),
  );
  el.textContent = `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ↻`;
}
function entryModal(kind = "expense") {
  modal(
    "记下这一笔",
    `<form id="entry-form"><div class="form-grid">${select("类型", "kind", '<option value="expense">支出</option><option value="income">收入</option><option value="transfer">池间转账</option>')}${field("金额（元）", "amount", "", "number", "", 'min="0.01" step="0.01" required autofocus')}${select("使用资金池", "pool", poolOptions())}${field("记账日期", "date", state.d.today, "date", "可以补记；已结算日会自动修正", `min="${state.d.settings.start_date}" max="${state.d.today}" required`)}${select("转入资金池（转账时使用）", "to_pool", poolOptions("flex"))}${field("分类", "category", "", "text", "例如餐饮、交通、订阅", 'maxlength="40"')}<div class="field full"><label for="f-note">备注</label><input id="f-note" name="note" maxlength="240" placeholder="这笔消费用在哪里？"></div></div>${footer("确认记账")}</form>`,
  );
  $("#f-kind").value = kind;
  const syncKind = () => {
    const k = $("#f-kind").value;
    $("#f-to_pool").closest(".field").hidden = k !== "transfer";
    $("label[for=f-pool]").textContent =
      k === "income"
        ? "入账资金池"
        : k === "transfer"
          ? "转出资金池"
          : "使用资金池";
  };
  $("#f-kind").onchange = syncKind;
  syncKind();
  attachForm("#entry-form", async (data, key) => {
    const prior = gaugeData();
    const r = await api("/api/entries", data, key);
    $("#dialog").close();
    await refresh(false);
    const currentGauge = gaugeData();
    if (currentGauge.remaining !== prior.remaining) playQuotaEffect(currentGauge.remaining > prior.remaining ? "income" : "expense", prior);
  else if (animate && priorPool && dailyPoolGauge().balance !== priorPool.balance)
    playQuotaEffect(dailyPoolGauge().balance > priorPool.balance ? "income" : "expense", priorPool, true);
    toast(
      r.allocation?.flex
        ? `已记录 · 日常 ${yuan(r.allocation.daily)} + 灵活 ${yuan(r.allocation.flex)}`
        : "已记入账本",
    );
  });
}
function scheduleModal(id) {
  const s = state.schedules.find((s) => s.id === id) || {
    name: "每月生活费",
    amount: 180000,
    pool: "daily",
    frequency: "monthly",
    day: 1,
    time: "09:00",
    enabled: true,
  };
  modal(
    id ? "编辑自动入账" : "添加自动入账",
    `<form id="schedule-form"><div class="form-grid">${field("名称", "name", s.name, "text", "", 'maxlength="60" required')}${field("入账金额（元）", "amount", (s.amount / 100).toFixed(2), "number", "", 'min="0.01" step="0.01" required')}${select("频率", "frequency", `<option value="monthly" ${s.frequency === "monthly" ? "selected" : ""}>每月</option><option value="daily" ${s.frequency === "daily" ? "selected" : ""}>每天</option>`)}${field("每月第几日", "day", s.day, "number", "设为 31 时，短月自动用月末", 'min="1" max="31" required')}${field("入账时间", "time", s.time, "time", "", "required")}${select("入账资金池", "pool", poolOptions(s.pool))}<label class="switch full"><input name="enabled" type="checkbox" ${s.enabled ? "checked" : ""}>启用计划</label></div>${footer()}</form>`,
  );
  attachForm("#schedule-form", async (data, key, form) => {
    data.day = Number(data.day);
    data.enabled = $("[name=enabled]", form).checked;
    if (id) data.id = id;
    await api("/api/schedules", data, key);
    $("#dialog").close();
    await refresh();
    toast("入账计划已保存");
  });
}
function reviewModal() {
  modal(
    "对账 · 核对实际分配金额",
    `<form id="review-form"><div class="form-grid">${select("周期", "mode", '<option value="day">每日</option><option value="month">每月</option>')}${field("对账日期", "period", state.d.today, "date", "每月对账请选已结束的月份", "required")}<div class="full inline-callout" id="expected-balances">选择周期，查看账面余额。</div>${Object.entries(
      pools,
    )
      .map(([k, v]) =>
        field(
          v + "实核金额（元）",
          k,
          "",
          "number",
          "",
          'step="0.01" required',
        ),
      )
      .join(
        "",
      )}${field("备注", "note", "", "text", "只记录差异；不会自动调平", 'maxlength="240"')}</div>${footer("保存对账记录")}</form>`,
  );
  const update = async () => {
    try {
      const r = await api(
        "/api/summary?period=" + encodeURIComponent($("#f-period").value),
      );
      $("#expected-balances").textContent =
        "账面：" +
        Object.entries(r.expected)
          .map(([k, v]) => pools[k] + " " + yuan(v))
          .join(" / ");
    } catch (e) {
      $("#expected-balances").textContent = e.message;
    }
  };
  $("#f-mode").onchange = () => {
    $("#f-period").type = $("#f-mode").value === "month" ? "month" : "date";
    $("#f-period").value =
      $("#f-mode").value === "month"
        ? state.d.today.slice(0, 7)
        : state.d.today;
    update();
  };
  $("#f-period").onchange = update;
  update();
  attachForm("#review-form", async (data, key) => {
    const r = await api(
      "/api/reviews",
      {
        period: data.period,
        actual: { daily: data.daily, flex: data.flex, reserve: data.reserve },
        note: data.note,
      },
      key,
    );
    $("#dialog").close();
    await refresh();
    toast(r.matched ? "已对账，金额一致" : "已记录差异，请核查后再调整余额");
  });
}
function bindPage() {
  document.querySelectorAll(".allocation .total,.metric .value").forEach(el => {
    const wide = el.textContent.trim().length > 12;
    el.classList.toggle("wide-money", wide);
    if (el.closest(".metric")) el.closest(".metric").classList.toggle("wide-money-card", wide);
  });
  updatePoolArtwork(null);
  document.querySelectorAll("[data-pool-move]").forEach(b => { b.onclick = () => poolMoveModal(b.dataset.poolMove, b.dataset.direction); });
  document
    .querySelectorAll("[data-height]")
    .forEach((el) => (el.style.height = el.dataset.height + "px"));
  document
    .querySelectorAll("[data-width]")
    .forEach((el) => (el.style.width = el.dataset.width + "%"));
  if ($("#view-ledger"))
    $("#view-ledger").onclick = () => {
      state.page = "ledger";
      refresh();
    };
  if ($("#filter-form"))
    $("#filter-form").onsubmit = (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      state.start = f.get("start");
      state.end = f.get("end");
      state.offset = 0;
      refresh().catch((e) => toast(e.message));
    };
  if ($("#clear-filter"))
    $("#clear-filter").onclick = () => {
      state.start = "";
      state.end = "";
      state.offset = 0;
      refresh();
    };
  if ($("#prev-page"))
    $("#prev-page").onclick = () => {
      state.offset = Math.max(0, state.offset - 30);
      refresh();
    };
  if ($("#next-page"))
    $("#next-page").onclick = () => {
      state.offset += 30;
      refresh();
    };
  document.querySelectorAll("[data-reverse]").forEach(
    (b) =>
      (b.onclick = () => {
        modal(
          "撤销流水",
          `<form id="reverse-form"><p class="subtle">原记录会保留，新增一笔反向记录。相关结算会自动修正。</p><div class="section-gap">${field("撤销原因", "reason", "", "text", "", 'required maxlength="240"')}</div>${footer("确认撤销")}</form>`,
        );
        attachForm("#reverse-form", async (data, key) => {
          await api("/api/reverse", { id: b.dataset.reverse, ...data }, key);
          $("#dialog").close();
          await refresh();
          toast("已撤销，审计记录已保留");
        });
      }),
  );
  if ($("#new-review")) $("#new-review").onclick = reviewModal;
  if ($("#settle-today"))
    $("#settle-today").onclick = async () => {
      try {
        const r = await api("/api/settle", { date: state.d.today });
        await refresh();
        toast(`结算已核对 · 本次净划转 ${yuan(r.new_transfer)}`);
      } catch (e) {
        toast(e.message);
      }
    };
  attachForm("#settings-form", async (data, key, form) => {
    data.revision = state.d.settings.revision;
    data.review_day = Number(data.review_day);
    data.carry_over = $("[name=carry_over]", form).checked;
    await api("/api/settings", data, key);
    await refresh();
    toast("规则已保存");
  });
  document.querySelectorAll("[data-adjust]").forEach(
    (b) =>
      (b.onclick = () => {
        const p = b.dataset.adjust;
        modal(
          "调整" + pools[p] + "余额",
          `<form id="adjust-form"><div class="form-grid">${field("调整后余额（元）", "balance", (state.d.balances[p] / 100).toFixed(2), "number", "", 'step="0.01" required')}${field("调整原因", "reason", "", "text", "", 'required maxlength="240"')}</div><div class="inline-callout">将新增差额记录，不会删除原流水。此操作不会改变银行卡余额。</div>${footer("确认调整")}</form>`,
        );
        attachForm("#adjust-form", async (data, key) => {
          await api("/api/adjust", { pool: p, ...data }, key);
          $("#dialog").close();
          await refresh();
          toast("余额已调整并留痕");
        });
      }),
  );
  if ($("#new-schedule")) $("#new-schedule").onclick = () => scheduleModal();
  document
    .querySelectorAll("[data-schedule]")
    .forEach((b) => (b.onclick = () => scheduleModal(b.dataset.schedule)));
  document.querySelectorAll("[data-revoke]").forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          await api("/api/tokens/revoke", { id: b.dataset.revoke });
          await refresh();
          toast("令牌已撤销");
        } catch (e) {
          toast(e.message);
        }
      }),
  );
  if ($("#new-agent"))
    $("#new-agent").onclick = () => {
      modal(
        "连接一个 Agent",
        `<form id="agent-form"><div class="form-grid">${field("Agent 名称", "name", "", "text", "例如你的个人助理", 'required maxlength="60"')}${select("访问权限", "scope", '<option value="read">仅查询</option><option value="write">查询、记账与通知</option><option value="manage">查询、记账与预算管理</option>')}</div>${footer("生成专用令牌")}</form>`,
      );
      attachForm("#agent-form", async (data) => {
        const r = await api("/api/tokens", {
          name: data.name,
          scopes:
            data.scope === "manage"
              ? ["read", "write", "manage"]
              : data.scope === "write"
                ? ["read", "write"]
                : ["read"],
        });
        $("#dialog").close();
        modal(
          "令牌只显示这一次",
          `<p class="subtle">请复制到 Agent 的私有环境变量 POCKETQUOTA_TOKEN。关闭后无法重新查看，丢失时请撤销重建。</p><div class="token-secret" id="new-token">${esc(r.token)}</div><button class="primary" id="copy-token">复制令牌</button>`,
        );
        $("#copy-token").onclick = () =>
          navigator.clipboard
            .writeText(r.token)
            .then(() => toast("已复制"))
            .catch(() => toast("请手动选择令牌复制"));
        await refresh();
      });
    };
}
start().catch(() =>
  login().catch(() => {
    $("#app").textContent = "暂时无法连接服务，请刷新重试。";
  }),
);

function account() {
  return `${title("", "账号", "", '<button class="secondary" id="sign-out">退出登录</button>')}<section class="panel"><div class="panel-heading"><h2>${esc(state.session.username || "admin")}</h2><button class="secondary" id="change-password">修改密码</button></div><span class="badge">${state.session.site_admin ? "站点管理员" : "个人账号"}</span></section>${state.session.site_admin ? `<section class="panel section-gap"><div class="panel-heading"><h2>用户</h2><button class="primary" id="new-user">＋ 新建账号</button></div>${(state.users || []).map((u) => `<div class="schedule-item"><div><strong>${esc(u.username)}</strong><small>${u.active ? "正常" : "已停用"}</small></div>${u.id !== "owner" ? `<div><button class="ghost" data-reset-user="${u.id}">重置密码</button><button class="ghost" data-toggle-user="${u.id}" data-active="${u.active}">${u.active ? "停用" : "启用"}</button></div>` : ""}</div>`).join("")}</section>` : ""}`;
}
function showCredentials(data) {
  modal(
    "初始登录信息",
    `<div class="credentials"><label>账号</label><strong>${esc(data.username)}</strong><label>随机密码 · 仅显示一次</label><div class="token-secret">${esc(data.password)}</div></div><button class="primary" id="copy-credentials">复制登录信息</button>`,
  );
  $("#copy-credentials").onclick = () =>
    navigator.clipboard
      .writeText("账号：" + data.username + "\n密码：" + data.password)
      .then(() => toast("已复制"))
      .catch(() => toast("请手动复制"));
}
function bindAccount() {
  if ($("#sign-out"))
    $("#sign-out").onclick = async () => {
      await api("/api/logout", {});
      await login();
    };
  if ($("#change-password"))
    $("#change-password").onclick = () => {
      modal(
        "修改密码",
        `<form id="password-form"><div class="form-grid">${field("当前密码", "old_password", "", "password", "", 'required autocomplete="current-password"')}${field("新密码", "new_password", "", "password", "", 'required minlength="12" maxlength="256" autocomplete="new-password"')}${field("确认新密码", "confirm", "", "password", "", 'required minlength="12" autocomplete="new-password"')}</div><p class="subtle">修改后，其他登录及 Agent 令牌将失效。</p>${footer("更新密码")}</form>`,
      );
      attachForm("#password-form", async (data) => {
        if (data.new_password !== data.confirm)
          throw new Error("两次新密码不一致");
        delete data.confirm;
        const r = await api("/api/password", data);
        state.csrf = r.csrf;
        $("#dialog").close();
        await start();
        toast("密码已更新");
      });
    };
  if ($("#new-user"))
    $("#new-user").onclick = () => {
      modal(
        "新建账号",
        `<form id="user-form">${field("账号名", "username", "", "text", "", 'required minlength="3" maxlength="40" autocomplete="off"')}${footer("创建并生成密码")}</form>`,
      );
      attachForm("#user-form", async (data) => {
        const r = await api("/api/users", data);
        $("#dialog").close();
        await refresh();
        showCredentials(r);
      });
    };
  document.querySelectorAll("[data-reset-user]").forEach(
    (b) =>
      (b.onclick = () => {
        modal(
          "重置密码",
          `<form id="reset-user-form"><p class="subtle">生成新密码，并撤销该用户的所有会话和 Agent 令牌。</p>${footer("确认重置")}</form>`,
        );
        attachForm("#reset-user-form", async () => {
          const r = await api("/api/users/reset", { id: b.dataset.resetUser });
          $("#dialog").close();
          await refresh();
          showCredentials(r);
        });
      }),
  );
  document.querySelectorAll("[data-toggle-user]").forEach(
    (b) =>
      (b.onclick = () => {
        const active = b.dataset.active !== "1";
        modal(
          active ? "启用账号" : "停用账号",
          `<form id="toggle-user-form">${footer("确认")}</form>`,
        );
        attachForm("#toggle-user-form", async () => {
          await api("/api/users/status", { id: b.dataset.toggleUser, active });
          $("#dialog").close();
          await refresh();
        });
      }),
  );
}
