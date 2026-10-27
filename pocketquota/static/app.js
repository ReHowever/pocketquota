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
const pools = { daily: "日常池", flex: "灵活池", reserve: "保底池" };
const kinds = {
  expense: "支出",
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
}
applyAppearance();
let refreshTimer, countTimer;
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
  document.body.classList.remove("bankrupt");
  const info = await api("/api/info");
  $("#app").innerHTML =
    `<main class="login">${brand}<div class="eyebrow">YOUR LIFE, WITHIN LIMITS</div><h1>给生活，一个舒服的额度。</h1><p>日常有边界，灵活有余地。<br>像管理 Agent 一样管理自己的消费习惯。</p><form id="login-form">${field("管理员登录口令", "token", "", "password", "口令位于部署实例的数据目录 admin.token；不会保存在浏览器存储中。", 'required autocomplete="current-password"')}<div class="form-error" role="alert"></div><button class="primary" type="submit">进入我的账本 ${icon("arrow")}</button></form>${info.demo ? '<button id="demo-login" class="secondary">试用演示账本 · 全部为虚构数据</button>' : ""}<p class="tagline">自托管 · 整数金额 · Agent 原生接口</p></main>`;
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
  const prior = state.d?.initialized ? gaugeData() : null;
  const oldTotal = state.d?.initialized
    ? Object.values(state.d.balances).reduce((a, b) => a + b, 0)
    : null;
  state.d = await api("/api/dashboard");
  if (!state.d.initialized) return setup();
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
  Object.assign(state, {
    entries: entries.items,
    total: entries.total,
    schedules,
    reviews,
    notifications,
    rules,
  });
  if (state.page === "agents") state.tokens = await api("/api/tokens");
  render();
  const total = Object.values(state.d.balances).reduce((a, b) => a + b, 0);
  if (animate && prior && oldTotal !== null && total !== oldTotal)
    playQuotaEffect(total > oldTotal ? "income" : "expense", prior);
}
function appearanceModal() {
  modal(
    "定制你的额度界面",
    `<form id="appearance-form"><div class="form-grid">${select("界面主题", "theme", '<option value="dark">深空黑</option><option value="light">极简白</option>')}${select("额度条形态", "shape", '<option value="linear">光轨 · 线形额度条</option><option value="ring">轨道 · 圆环额度条</option>')}${select("光谱配色", "palette", '<option value="aurora">极光 · 紫蓝渐变</option><option value="blue">离子 · 冰蓝</option><option value="ember">日珥 · 橙金</option>')}${select("主额度条显示", "metric", '<option value="daily">今日可用额度</option><option value="total">总可消费预算</option>')}<label class="switch full"><input name="motion" type="checkbox" ${appearance.motion ? "checked" : ""}>启用额度粒子动效</label></div>${footer("应用外观")}</form>`,
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
function gauge() {
  const g = gaugeData();
  if (appearance.shape === "ring")
    return `<div class="orbit-layout"><div class="quota-orbit" id="quota-gauge" role="progressbar" aria-label="剩余额度比例" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${g.percent}"><svg viewBox="0 0 180 180" aria-hidden="true"><defs><linearGradient id="orbit-gradient"><stop offset="0%" class="orbit-stop-a"/><stop offset="100%" class="orbit-stop-b"/></linearGradient></defs><circle class="orbit-track" cx="90" cy="90" r="76"/><circle class="orbit-fill" cx="90" cy="90" r="76" stroke-dasharray="477.522" stroke-dashoffset="${477.522 * (1 - g.percent / 100)}"/></svg><div class="orbit-center"><strong>${g.percent.toFixed(1)}<small>%</small></strong></div></div><div class="orbit-caption"><strong>${yuan(g.remaining)}</strong><small>OF ${yuan(g.cap)}</small><div class="orbit-dots">•••</div></div></div>`;
  return `<div class="progress-info"><span>${appearance.metric === "total" ? "总可消费预算" : "今日可用"} ${yuan(g.remaining)} / ${yuan(g.cap)}</span><strong>${g.percent.toFixed(1)}% 可用</strong></div><div class="quota-track" id="quota-gauge" role="progressbar" aria-label="剩余额度比例" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${g.percent}"><div class="quota-fill" data-width="${g.percent}"><span class="fill-sheen"></span></div><div class="track-ticks" aria-hidden="true"></div></div>`;
}
function playQuotaEffect(type, prior) {
  if (
    !appearance.motion ||
    matchMedia("(prefers-reduced-motion: reduce)").matches ||
    state.page !== "home"
  )
    return;
  const gauge = $("#quota-gauge"),
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
    style.getPropertyValue("--accent").trim(),
    style.getPropertyValue("--accent2").trim(),
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
  const g = gaugeData(),
    income = type === "income",
    cx = rect.left - card.left + rect.width / 2,
    cy = rect.top - card.top + rect.height / 2;
  const oldPct = prior?.percent ?? g.percent;
  const low = Math.min(oldPct, g.percent) / 100,
    high = Math.max(oldPct, g.percent) / 100;
  const fill = $(".quota-fill", gauge),
    arc = $(".orbit-fill", gauge);
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
    arc.style.strokeDashoffset = 477.522 * (1 - oldPct / 100);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        arc.style.transition = "";
        arc.style.strokeDashoffset = 477.522 * (1 - g.percent / 100);
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
      x = cx + Math.cos(a) * rect.width * 0.42;
      y = cy + Math.sin(a) * rect.height * 0.42;
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
    `<main class="setup">${brand}<h1>从一个真实的起点开始</h1><p>填写你现在准备分配的金额。这是预算分配，不会连接银行，也不会移动真实资金。</p><form id="setup-form"><div class="form-grid">${field("账本名称", "name", "我的生活额度")}${field("每日限额（元）", "daily_limit", "60.00", "number", "", 'min="0" step="0.01" required')}${field("日常池（元）", "daily", "0.00", "number", "", 'min="0" step="0.01" required')}${field("灵活池（元）", "flex", "0.00", "number", "", 'min="0" step="0.01" required')}${field("保底池（元）", "reserve", "0.00", "number", "不会自动用于补足日常支出", 'min="0" step="0.01" required')}${field("每天结算时间", "settle_time", "21:00", "time")}${field("时区", "timezone", "Asia/Shanghai", "text", "初始化后固定，避免同一天重复结算")}</div>${footer("建立我的账本")}</form></main>`;
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
];
function render() {
  clearInterval(countTimer);
  const d = state.d;
  document.body.classList.toggle("bankrupt", d.bankrupt);
  $("#app").innerHTML =
    `<div class="shell"><aside class="sidebar">${brand}<div class="nav-label">PERSONAL CONSOLE</div><nav class="nav" aria-label="主导航">${navItems.map(([id, label]) => `<button data-nav="${id}" class="${id === state.page ? "active" : ""}" ${id === state.page ? 'aria-current="page"' : ""}>${icon(id)}${label}</button>`).join("")}</nav><div class="side-foot"><span>自托管 · v0.1.0</span><span>◉</span></div></aside><main class="workspace"><header class="topbar"><div><span class="crumb">我的工作区</span> / ${esc(d.settings.name)}</div><div class="top-actions"><span class="hide-mobile">${esc(d.today)} · ${esc(d.settings.timezone)}</span><span><i class="status-dot"></i>${state.session.demo ? "演示数据" : "私人账本"}</span><a class="guide-link" href="/guide.html" target="_blank" rel="noopener">指南 ↗</a><button class="appearance-button" id="appearance" title="主题、配色与额度条">◐ <span>外观</span></button><button class="ghost" id="refresh" title="刷新">↻</button><button class="avatar" id="logout" aria-label="退出登录">P</button></div></header><div id="page">${{ home: home, ledger: ledger, review: review, rules: rules, agents: agents }[state.page]()}</div></main></div>`;
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
  $("#logout").onclick = async () => {
    await api("/api/logout", {});
    await login();
  };
  document
    .querySelectorAll("[data-add]")
    .forEach((b) => (b.onclick = () => entryModal(b.dataset.add)));
  bindPage();
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
          const expense = r.kind === "expense";
          const positive = ["income", "scheduled_income", "opening"].includes(
            r.kind,
          );
          return `<div class="transaction"><div class="tx-symbol">${expense ? "↗" : positive ? "↙" : "⇄"}</div><div class="tx-main"><strong>${esc(r.note || r.category || kinds[r.kind])}</strong><small>${esc(r.date)} · ${esc(pools[r.pool])} · ${r.actor.startsWith("agent:") ? "Agent" : r.actor === "scheduler" ? "自动规则" : "手动"}${r.reversed ? " · 已撤销" : ""}</small></div><div class="tx-amount ${positive ? "income" : ""}">${expense ? "−" : positive ? "+" : ""}${yuan(r.amount)}<small>${esc(kinds[r.kind])}</small></div></div>`;
        })
        .join("")
    : '<div class="empty">暂无流水</div>';
}
function home() {
  const d = state.d;
  const percent = Math.max(0, Math.min(100, d.usage_percent || 0));
  return `${title("BUDGET OVERVIEW", "额度总览", "让消费有边界，让选择有余地。", addButton())}${bankruptcy()}<div class="overview-grid"><section class="quota"><canvas id="quota-fx" aria-hidden="true"></canvas><div class="card-top"><h2>${appearance.metric === "total" ? "总可消费预算" : "今日可用额度"}</h2><span class="live-dot" aria-label="已同步"></span></div>${appearance.shape === "linear" ? `<div class="big-amount"><small>¥</small>${fmt(gaugeData().remaining)}</div>${appearance.metric === "daily" && d.remaining < 0 ? `<span class="excess-tag">+${yuan(-d.remaining)}</span>` : ""}` : ""}${gauge()}<div class="reset-line"><span id="countdown"></span><span>${esc(d.settings.settle_time)}</span></div></section><section class="allocation"><div class="card-top"><h2>我的资金池</h2></div><div class="total">${yuan(d.spendable)}</div><div class="pool-lines">${Object.entries(
    pools,
  )
    .map(
      ([k, v]) =>
        `<div class="pool-line"><span><i class="dot ${k}"></i>${v}</span><strong>${yuan(d.balances[k])}</strong></div>`,
    )
    .join(
      "",
    )}</div></section></div><div class="metrics"><div class="metric"><div class="metric-label">本月已支出 ${icon("wallet")}</div><div class="value">${yuan(d.month_expense)}</div></div><div class="metric"><div class="metric-label">本月已入账 ${icon("arrow")}</div><div class="value">${yuan(d.month_income)}</div></div><div class="metric"><div class="metric-label">${d.settled ? "今日结算状态" : "预计今日结余"} ${icon("clock")}</div><div class="value">${d.settled ? "已结算" : yuan(d.projected_carry)}</div></div></div><div class="lower-grid"><section class="panel"><div class="panel-heading"><h2>最近的消费与变动</h2><button class="ghost" id="view-ledger">查看全部 →</button></div><div class="ledger-list">${txList(state.entries.slice(0, 5))}</div></section><section class="panel"><div class="panel-heading"><h2>近 7 日额度使用</h2><small>日常消费</small></div><div class="chart">${d.trend.map((r, i) => `<div class="chart-col"><div class="chart-value">${r.spent ? fmt(r.spent) : "—"}</div><div class="bar-area"><div class="bar" data-height="${Math.max(3, (r.spent / Math.max(...d.trend.map((x) => Math.max(x.spent, x.limit)), 1)) * 108)}" title="${esc(r.date)}：${yuan(r.spent)}"></div></div><small>${i === 6 ? "今天" : r.date.slice(5).replace("-", "/")}</small></div>`).join("")}</div></section></div>${d.warnings.length ? `<div class="inline-callout red-callout">${d.warnings.map(esc).join("<br>")}</div>` : ""}`;
}
function ledger() {
  return `${title("TRANSACTION JOURNAL", "收支流水", "补记、撤销和自动划转都会保留记录。余额调整不会抹去历史。", addButton())}<section class="panel"><div class="panel-heading"><h2>收支流水 <small>共 ${state.total} 笔</small></h2><a class="secondary" href="/api/export.csv?start=${encodeURIComponent(state.start)}&amp;end=${encodeURIComponent(state.end)}">导出 CSV</a></div><form id="filter-form" class="filters"><label>起始 <input name="start" type="date" value="${esc(state.start)}"></label><label>截止 <input name="end" type="date" value="${esc(state.end)}"></label><button class="secondary" type="submit">筛选</button><button class="ghost" type="button" id="clear-filter">重置</button></form><div class="table-wrap"><table><thead><tr><th>日期 / 来源</th><th>用途</th><th>金额</th><th>资金池 / 实际承担</th><th>操作</th></tr></thead><tbody>${state.entries
    .map(
      (r) =>
        `<tr><td>${esc(r.date)}<small>${r.actor.startsWith("agent:") ? "Agent" : esc(r.actor)}</small></td><td>${esc(r.note || r.category || kinds[r.kind])}<small>${esc(kinds[r.kind])} ${r.reversed ? "· 已撤销" : ""}</small></td><td class="mono">${yuan(r.amount)}</td><td><span class="badge">${esc(pools[r.pool])}</span>${
          r.kind === "expense"
            ? `<small>${Object.entries(r.postings)
                .filter(([k, v]) => k !== "external" && v < 0)
                .map(([k, v]) => esc(pools[k]) + " " + yuan(-v))
                .join(" + ")}</small>`
            : ""
        }</td><td>${["expense", "income", "transfer"].includes(r.kind) && !r.reversed ? `<button class="ghost warning" data-reverse="${r.id}">撤销</button>` : "—"}</td></tr>`,
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
  return `${title("AGENT CONNECTIONS", "Agent", "同一套账本，多个入口。只读查询、对话记账、通知领取，各有边界。", '<button class="primary" id="new-agent">' + icon("plus") + " 连接 Agent</button>")}<div class="two-cols"><section class="panel"><div class="panel-heading"><h2>访问凭据</h2><span class="pill">可随时撤销</span></div>${state.tokens.length ? state.tokens.map((t) => `<div class="schedule-item"><div><strong>${esc(t.name)}</strong><small>${JSON.parse(t.scopes).includes("manage") ? "预算管理" : JSON.parse(t.scopes).includes("write") ? "查询 + 记账" : "仅查询"} · ${t.revoked ? "已撤销" : "有效"}</small></div>${!t.revoked ? `<button class="ghost warning" data-revoke="${t.id}">撤销</button>` : ""}</div>`).join("") : '<div class="empty">暂无连接</div>'}</section><section class="panel"><div class="panel-heading"><h2>额度通知</h2><span class="pill">${state.notifications.length} 条待处理</span></div>${state.notifications.map((n) => `<div class="inline-callout red-callout"><strong>赤字 · 已破产</strong><br>缺口 ${yuan(n.data.deficit)} · ${esc(n.created_at.slice(0, 10))}<br>待投递</div>`).join("") || '<div class="inline-callout">暂无通知</div>'}</section></div><section class="panel section-gap"><div class="panel-heading"><h2>接入方式</h2><a class="guide-link" href="/guide.html#agents" target="_blank" rel="noopener">指南 ↗</a></div><div class="connector-grid"><a href="/guide.html#agents" target="_blank" rel="noopener">MCP <span>↗</span></a><a href="/openapi.json" target="_blank" rel="noopener">REST <span>↗</span></a><a href="/guide.html#agents" target="_blank" rel="noopener">Codex <span>↗</span></a><a href="/guide.html#agents" target="_blank" rel="noopener">Claude <span>↗</span></a><a href="/guide.html#agents" target="_blank" rel="noopener">Cursor <span>↗</span></a><a href="/guide.html#agents" target="_blank" rel="noopener">Gemini <span>↗</span></a></div></section>`;
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
    playQuotaEffect(data.kind === "income" ? "income" : "expense", prior);
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
