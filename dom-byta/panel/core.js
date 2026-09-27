// Общее для входа, админки и кабинета: запросы к API, сборка DOM, роутер по #hash,
// диалоги, уведомления и подписи статусов. Без сборки — обычный ES-модуль.

export async function api(method, url, body) {
  const opts = { method, headers: {}, credentials: "same-origin" };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw Object.assign(new Error("Нет связи с сервером — проверьте интернет"), { code: "network" });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `Ошибка ${res.status}`);
    err.code = data.error;
    err.status = res.status;
    throw err;
  }
  return data;
}

export const get = (url) => api("GET", url);
export const post = (url, body = {}) => api("POST", url, body);
export const patch = (url, body) => api("PATCH", url, body);
export const put = (url, body) => api("PUT", url, body);
export const del = (url) => api("DELETE", url);

// h("a", { href: "#x", class: "btn", onclick }, "текст", childNode)
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "class") el.className = v;
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k === "html") el.innerHTML = v;
      else if (k === "value") el.value = v;
      else if (k in el && typeof v !== "string") el[k] = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function mount(target, ...children) {
  target.replaceChildren();
  append(target, children);
}

// ---------- Форматирование ----------

const dateFmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
const dateYearFmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });

export function fmtDate(value) {
  if (!value) return "";
  const d = new Date(value);
  return (d.getFullYear() === new Date().getFullYear() ? dateFmt : dateYearFmt).format(d).replace(".", "");
}

export function fmtDateTime(value) {
  if (!value) return "";
  const d = new Date(value);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  const time = timeFmt.format(d);
  if (d.toDateString() === today.toDateString()) return `сегодня, ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `вчера, ${time}`;
  return `${fmtDate(d)}, ${time}`;
}

export const fmtNum = (n) => Number(n || 0).toLocaleString("ru-RU");
export const fmtMoney = (n) => `${fmtNum(n)} ₽`;

export function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// ---------- Подписи статусов ----------

export const LABELS = {
  moderation: {
    draft: "Черновик",
    pending: "На модерации",
    published: "На сайте",
    rejected: "Отклонено",
    archived: "В архиве",
  },
  availability: { available: "Свободно", reserved: "На просмотре", occupied: "Сдано" },
  lead: {
    new: "Новая",
    in_progress: "В работе",
    viewing: "Просмотр",
    won: "Договор",
    lost: "Отказ",
    spam: "Спам",
  },
  leadKind: { listing: "На помещение", owner: "От собственника", contact: "Общая" },
  role: { admin: "Администратор", landlord: "Собственник", tenant: "Арендатор" },
  userStatus: { active: "Активен", pending: "Ждёт подтверждения", blocked: "Заблокирован" },
  provider: { telegram: "Telegram", yandex: "Яндекс ID", vk: "VK ID" },
};

export function badge(group, value, tone = value) {
  return h("span", { class: "badge", dataset: { tone } }, LABELS[group][value] || value);
}

// Схема этажей: 8 полосок, нужная подсвечена.
export function floorMark(floor, floors = 8) {
  const stack = h("span", { class: "floor-mark__stack", "aria-hidden": "true" });
  for (let i = 1; i <= floors; i++) stack.append(h("i", { "data-on": i === floor || undefined }));
  return h("span", { class: "floor-mark", title: `Этаж ${floor}` }, stack, h("span", { class: "floor-mark__num" }, floor), h("span", { class: "visually-hidden" }, "этаж"));
}

// ---------- Уведомления и диалоги ----------

let toastsEl = null;
export function toast(message, tone) {
  if (!toastsEl) {
    toastsEl = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(toastsEl);
  }
  const el = h("div", { class: "toast", dataset: tone ? { tone } : undefined }, message);
  toastsEl.append(el);
  setTimeout(() => el.remove(), tone === "error" ? 6000 : 3500);
}

export const toastError = (err) => toast(err.message || String(err), "error");

// Диалог подтверждения. withText — показать поле для комментария (вернётся строка).
export function confirmDialog({ title, text, confirm = "Подтвердить", danger = false, withText = null }) {
  return new Promise((resolve) => {
    const area = withText
      ? h("div", { class: "field" }, h("label", { for: "dlg-text" }, withText.label), h("textarea", { id: "dlg-text", rows: 3, placeholder: withText.placeholder || "" }))
      : null;
    const errorEl = h("p", { class: "form-error" });
    const dlg = h(
      "dialog",
      null,
      h("h2", null, title),
      text ? h("p", { class: "muted" }, text) : null,
      area,
      errorEl,
      h(
        "div",
        { class: "form-actions" },
        h("button", { class: "btn btn-ghost", type: "button", onclick: () => close(null) }, "Отмена"),
        h("button", { class: `btn ${danger ? "btn-danger" : "btn-primary"}`, type: "button", onclick: ok }, confirm)
      )
    );
    function ok() {
      if (withText) {
        const v = dlg.querySelector("textarea").value.trim();
        if (withText.required && !v) {
          errorEl.textContent = withText.required;
          return;
        }
        close(v);
      } else close(true);
    }
    function close(value) {
      dlg.close();
      dlg.remove();
      resolve(value);
    }
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      close(null);
    });
    document.body.append(dlg);
    dlg.showModal();
  });
}

// Кнопка, которая на время запроса блокируется.
export async function busy(button, fn) {
  button.setAttribute("aria-busy", "true");
  try {
    return await fn();
  } finally {
    button.removeAttribute("aria-busy");
  }
}

export function loading() {
  return h("div", { class: "loading" }, h("div", { class: "spinner", role: "status", "aria-label": "Загрузка" }));
}

// ---------- Сессия ----------

export async function session(roles) {
  const { user, providers } = await get("/api/auth/me");
  if (!user) {
    location.replace(`/login/?next=${encodeURIComponent(location.pathname + location.hash)}`);
    return new Promise(() => {});
  }
  if (roles && !roles.includes(user.role)) {
    location.replace(user.role === "admin" ? "/admin/" : "/cabinet/");
    return new Promise(() => {});
  }
  return { user, providers };
}

export async function logout() {
  await post("/api/auth/logout");
  location.href = "/login/";
}

// ---------- Каркас и роутер ----------

// nav: [{ id: "listings", label: "Объявления", count?: number }]
// routes: { listings: (ctx) => Node|Promise<Node>, "listing/:id": ... }
export function app({ title, nav, routes, user, fallback }) {
  const root = document.getElementById("app");
  const content = h("main", { class: "main", id: "content", tabindex: "-1" });
  const navEl = h("nav", { class: "nav", "aria-label": "Разделы" });
  const counts = {};
  const shell = h("div", { class: "shell" });

  const brand = () =>
    h("a", { class: "brand", href: "/" }, h("span", { class: "brand-mark", "aria-hidden": "true" }), h("span", { class: "brand-text" }, h("span", { class: "brand-title" }, "Дом быта"), h("span", { class: "brand-sub" }, title)));

  const sidebar = h(
    "aside",
    { class: "sidebar", id: "sidebar" },
    brand(),
    navEl,
    h(
      "div",
      { class: "sidebar-foot" },
      h("div", { class: "sidebar-user" }, h("strong", null, user.name || user.email || "Без имени"), h("span", { class: "muted" }, LABELS.role[user.role])),
      h("a", { class: "btn btn-quiet btn-sm", href: "/" }, "Открыть сайт"),
      h("button", { class: "btn btn-quiet btn-sm", type: "button", onclick: logout }, "Выйти")
    )
  );
  const toggle = h("button", { class: "btn btn-quiet", type: "button", "aria-controls": "sidebar", "aria-expanded": "false", "aria-label": "Меню", onclick: () => setNav(!shell.classList.contains("nav-open")) }, "☰");
  const topbar = h("header", { class: "topbar" }, toggle, brand());
  let scrim = null;
  function setNav(open) {
    shell.classList.toggle("nav-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    if (open && !scrim) {
      scrim = h("div", { class: "scrim", onclick: () => setNav(false) });
      shell.append(scrim);
    } else if (!open && scrim) {
      scrim.remove();
      scrim = null;
    }
  }

  mount(shell, sidebar, h("div", null, topbar, content));
  mount(root, shell);

  function renderNav(active) {
    mount(
      navEl,
      nav.map((item) =>
        h(
          "a",
          { href: `#${item.id}`, "aria-current": item.id === active ? "page" : undefined, onclick: () => setNav(false) },
          item.label,
          counts[item.id] ? h("span", { class: "nav-count" }, counts[item.id]) : null
        )
      )
    );
  }

  function match(hash) {
    const parts = hash.split("/");
    for (const [pattern, view] of Object.entries(routes)) {
      const p = pattern.split("/");
      if (p.length !== parts.length) continue;
      const params = {};
      if (p.every((seg, i) => (seg.startsWith(":") ? ((params[seg.slice(1)] = decodeURIComponent(parts[i])), true) : seg === parts[i]))) {
        return { view, params, section: p[0] };
      }
    }
    return null;
  }

  let renderId = 0;
  async function render() {
    const hash = location.hash.slice(1) || fallback;
    const m = match(hash) || match(fallback);
    const section = nav.find((n) => n.id === m.section || (n.match || []).includes(m.section))?.id;
    renderNav(section);
    const id = ++renderId;
    mount(content, loading());
    try {
      const node = await m.view({ params: m.params, rerender: render });
      if (id !== renderId) return;
      mount(content, node instanceof Element && node.classList.contains("page") ? node : h("div", { class: "page" }, node));
      content.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    } catch (err) {
      if (id !== renderId) return;
      if (err.status === 401) return location.replace("/login/");
      mount(content, h("div", { class: "page" }, h("div", { class: "banner", dataset: { tone: "error" } }, h("p", null, err.message), h("button", { class: "btn btn-ghost btn-sm", onclick: render }, "Повторить"))));
    }
  }

  window.addEventListener("hashchange", render);
  render();

  return {
    render,
    setCount(id, n) {
      counts[id] = n;
      renderNav(nav.find((x) => location.hash.slice(1).startsWith(x.id))?.id);
    },
  };
}

export function pageHead(title, sub, ...actions) {
  return h(
    "div",
    { class: "page-head" },
    h("div", null, h("h1", null, title), sub ? h("p", { class: "muted" }, sub) : null),
    actions.length ? h("div", { class: "page-actions" }, actions) : null
  );
}

export function backLink(href, text) {
  return h("a", { class: "back-link", href }, "← ", text);
}

// Вкладки-фильтры: tabs([["all", "Все"], ["new", "Новые"]], current, onChange)
export function tabs(items, current, onChange) {
  return h(
    "div",
    { class: "tabs", role: "group" },
    items.map(([value, label]) =>
      h("button", { type: "button", "aria-pressed": String(value === current), onclick: () => onChange(value) }, label)
    )
  );
}

// Поле формы: field("Название", input, "подсказка")
export function field(label, control, hint) {
  if (!control.id) control.id = `f-${Math.random().toString(36).slice(2, 9)}`;
  return h("div", { class: "field" }, h("label", { for: control.id }, label), control, hint ? h("p", { class: "hint" }, hint) : null);
}
