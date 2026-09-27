import { h, get, patch, put, session, app, pageHead, tabs, field, busy, toast, toastError, confirmDialog, LABELS, badge, fmtDateTime, fmtNum } from "./core.js";
import { listingRow, listingEditor, leadsList, leadDetail, statsView, profileView } from "./views.js";

const { user, providers } = await session(["admin"]);
let shell;

async function refreshCounts() {
  try {
    const d = await get("/api/admin/dashboard");
    shell.setCount("moderation", d.counts.moderation);
    shell.setCount("leads", d.counts.newLeads);
    shell.setCount("users", d.counts.pendingLandlords);
  } catch {
    // Счётчики в меню — не главное.
  }
}

// ---------- Сводка ----------

async function dashboard() {
  const d = await get("/api/admin/dashboard");
  const c = d.counts;
  const kpi = (value, label, href, alert) => h("a", { class: "card card-tight kpi", href, "data-alert": String(Boolean(alert && value)) }, h("span", { class: "kpi-value" }, fmtNum(value)), h("span", { class: "kpi-label" }, label));
  const todo = [];
  if (c.moderation) todo.push(["#moderation", `${c.moderation} на модерации`]);
  if (c.pendingLandlords) todo.push(["#users", `${c.pendingLandlords} собственник(ов) ждут подтверждения`]);
  if (c.newLeads) todo.push(["#leads", `${c.newLeads} новых заявок`]);
  return h(
    "div",
    { class: "page" },
    pageHead("Сводка", `Здравствуйте${user.name ? `, ${user.name}` : ""}.`),
    todo.length
      ? h("div", { class: "banner" }, h("div", null, h("strong", null, "Ждут вашего решения"), h("ul", { style: "margin-top: 6px; display: flex; gap: 6px 16px; flex-wrap: wrap" }, todo.map(([href, text]) => h("li", null, h("a", { href }, text))))))
      : null,
    h("div", { class: "grid grid-4" }, kpi(c.moderation, "на модерации", "#moderation", true), kpi(c.newLeads, "новых заявок", "#leads", true), kpi(c.pendingLandlords, "собственников ждут", "#users", true), kpi(c.available, `свободно из ${c.published} на сайте`, "#listings")),
    h(
      "div",
      { class: "grid grid-2", style: "align-items: start" },
      h("div", { class: "card" }, h("h2", null, "За 7 дней"), h("div", { class: "grid grid-2" }, [["Просмотры", d.week.views], ["Посетители", d.week.visitors], ["Открытия карточек", d.week.opens], ["Заявки", d.week.leads]].map(([l, v]) => h("div", { class: "kpi" }, h("span", { class: "kpi-value" }, fmtNum(v)), h("span", { class: "kpi-label" }, l)))), h("p", { style: "margin-top: 16px" }, h("a", { href: "#stats" }, "Вся статистика →"))),
      h(
        "div",
        { class: "card" },
        h("h2", null, "Последние заявки"),
        d.recentLeads.length
          ? h("ul", { class: "rows" }, d.recentLeads.map((l) => h("li", null, h("a", { class: "row row-lead", href: `#lead/${l.id}` }, h("span", { class: "row-main" }, h("span", { class: "row-title" }, l.name), h("span", { class: "row-meta" }, l.listingTitle || LABELS.leadKind[l.kind])), h("span", { class: "row-side" }, badge("lead", l.status), h("span", { class: "small muted nowrap" }, fmtDateTime(l.createdAt)))))))
          : h("p", { class: "muted" }, "Заявок пока не было.")
      )
    )
  );
}

// ---------- Модерация и объявления ----------

async function moderation() {
  const { listings } = await get("/api/admin/listings?moderation=queue");
  return h(
    "div",
    { class: "page" },
    pageHead("Модерация", "Новые объявления и правки опубликованных. Откройте, проверьте и опубликуйте или верните с комментарием."),
    listings.length
      ? h("div", { class: "rows" }, listings.map((l) => listingRow(l, `#listing/${l.id}`)))
      : h("div", { class: "empty" }, h("strong", null, "Очередь пуста"), h("span", null, "Когда собственник отправит объявление или правки, они появятся здесь, и мы пришлём уведомление."))
  );
}

let listingFilter = "published";
async function listings() {
  const q = listingFilter === "all" ? "" : `?moderation=${listingFilter}`;
  const { listings } = await get(`/api/admin/listings${q}`);
  return h(
    "div",
    { class: "page" },
    pageHead("Объявления", "Все помещения здания. Админ правит напрямую, без модерации.", h("a", { class: "btn btn-primary", href: "#new" }, "Новое объявление")),
    tabs([["published", "На сайте"], ["pending", "На модерации"], ["draft", "Черновики"], ["rejected", "Отклонённые"], ["archived", "Архив"], ["all", "Все"]], listingFilter, (v) => {
      listingFilter = v;
      shell.render();
    }),
    listings.length ? h("div", { class: "rows" }, listings.map((l) => listingRow(l, `#listing/${l.id}`))) : h("div", { class: "empty" }, h("span", null, "Здесь пусто."))
  );
}

// ---------- Пользователи ----------

let usersFilter = { role: "", status: "", q: "" };
async function users() {
  const qs = new URLSearchParams(Object.entries(usersFilter).filter(([, v]) => v));
  const { users } = await get(`/api/admin/users?${qs}`);
  const search = h("input", { class: "search", type: "search", placeholder: "Имя, почта, телефон, компания", value: usersFilter.q, style: "max-width: 320px" });
  let t;
  search.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => {
      usersFilter.q = search.value;
      shell.render().then(() => document.querySelector(".search")?.focus());
    }, 350);
  });

  async function update(u, body, done) {
    try {
      await patch(`/api/admin/users/${u.id}`, body);
      toast(done);
      refreshCounts();
      shell.render();
    } catch (err) {
      toastError(err);
    }
  }

  function actions(u) {
    const items = [];
    if (u.id === user.id) return h("span", { class: "muted small" }, "это вы");
    if (u.role === "landlord" && u.status === "pending") {
      items.push(h("button", { class: "btn btn-primary btn-sm", onclick: () => update(u, { status: "active" }, "Собственник подтверждён") }, "Подтвердить"));
    }
    if (u.status === "blocked") {
      items.push(h("button", { class: "btn btn-ghost btn-sm", onclick: () => update(u, { status: "active" }, "Разблокирован") }, "Разблокировать"));
    } else {
      items.push(h("button", { class: "btn btn-quiet btn-sm", onclick: async () => { if (await confirmDialog({ title: `Заблокировать ${u.name || u.email}?`, text: "Пользователь выйдет со всех устройств и не сможет войти.", confirm: "Заблокировать", danger: true })) update(u, { status: "blocked" }, "Заблокирован"); } }, "Заблокировать"));
    }
    const role = h("select", { class: "input", style: "min-height: 32px; padding: 2px 8px; width: auto", "aria-label": "Роль", onchange: async () => { if (await confirmDialog({ title: `Сменить роль на «${LABELS.role[role.value]}»?`, confirm: "Сменить" })) update(u, { role: role.value }, "Роль изменена"); else role.value = u.role; } }, Object.entries(LABELS.role).map(([v, l]) => h("option", { value: v, selected: v === u.role }, l)));
    items.push(role);
    return h("div", { class: "form-actions" }, items);
  }

  return h(
    "div",
    { class: "page" },
    pageHead("Пользователи", "Собственников подтверждает администратор — до этого они могут только готовить черновики."),
    h(
      "div",
      { class: "toolbar" },
      tabs([["", "Все"], ["landlord", "Собственники"], ["tenant", "Арендаторы"], ["admin", "Админы"]], usersFilter.role, (v) => { usersFilter.role = v; shell.render(); }),
      h("div", { class: "form-actions" }, tabs([["", "Любой статус"], ["pending", "Ждут"], ["blocked", "Заблокированы"]], usersFilter.status, (v) => { usersFilter.status = v; shell.render(); }), search)
    ),
    users.length
      ? h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            null,
            h("thead", null, h("tr", null, h("th", null, "Пользователь"), h("th", null, "Статус"), h("th", null, "Вход"), h("th", { class: "num" }, "Объявл."), h("th", null, "Действия"))),
            h(
              "tbody",
              null,
              users.map((u) =>
                h(
                  "tr",
                  null,
                  h("td", null, h("strong", null, u.name || u.company || "Без имени"), h("div", { class: "small muted" }, [u.email, u.phone, u.company && u.name ? u.company : ""].filter(Boolean).join(" · ") || "—")),
                  h("td", null, badge("userStatus", u.status), h("div", { class: "small muted" }, LABELS.role[u.role])),
                  h("td", { class: "small" }, u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : "—", h("div", { class: "muted" }, ["почта", ...u.identities.map((p) => LABELS.provider[p])].filter((x, i) => i || u.email).join(", "))),
                  h("td", { class: "num" }, u.listingsCount ? h("a", { href: "#listings", onclick: () => (listingFilter = "all") }, u.listingsCount) : "0"),
                  h("td", null, actions(u))
                )
              )
            )
          )
        )
      : h("div", { class: "empty" }, h("span", null, "Никого не нашлось."))
  );
}

// ---------- Журнал ----------

const AUDIT_LABELS = {
  register: "Регистрация",
  promote_admin: "Назначен админом",
  link_identity: "Привязан вход",
  unlink_identity: "Отвязан вход",
  set_password: "Задан пароль",
  change_email: "Сменена почта",
  landlord_request: "Запрос статуса собственника",
  user_update: "Изменён пользователь",
  create: "Создано объявление",
  edit: "Правка объявления",
  admin_edit: "Правка админом",
  availability: "Смена занятости",
  submit: "Отправлено на модерацию",
  approve: "Опубликовано",
  approve_changes: "Правки опубликованы",
  reject: "Отклонено",
  reject_changes: "Правки отклонены",
  discard_changes: "Правки отменены",
  archive: "В архив",
  unarchive: "Возвращено на сайт",
  restore: "Из архива",
  delete: "Удалено",
  lead_status: "Статус заявки",
  forward: "Заявка передана",
  setting: "Настройка",
};

let auditEntity = "";
async function audit() {
  const { entries } = await get(`/api/admin/audit?limit=200${auditEntity ? `&entity=${auditEntity}` : ""}`);
  const describe = (e) => {
    const m = e.meta || {};
    if (e.action === "availability") return `${LABELS.availability[m.from]} → ${LABELS.availability[m.to]}`;
    if (e.action === "lead_status") return `${LABELS.lead[m.from]} → ${LABELS.lead[m.to]}`;
    if (e.action === "user_update") return [m.role && `роль: ${m.role.map((r) => LABELS.role[r]).join(" → ")}`, m.status && `статус: ${m.status.map((s) => LABELS.userStatus[s]).join(" → ")}`].filter(Boolean).join(", ");
    if (e.action === "reject" || e.action === "reject_changes") return m.comment;
    if (e.action === "setting") return `${e.entityId} = ${JSON.stringify(m.value)}`;
    if (m.provider) return LABELS.provider[m.provider];
    if (m.title) return m.title;
    return "";
  };
  const link = (e) => {
    if (e.entity === "listing" && e.action !== "delete") return h("a", { href: `#listing/${e.entityId}` }, `объявление #${e.entityId}`);
    if (e.entity === "lead") return h("a", { href: `#lead/${e.entityId}` }, `заявка #${e.entityId}`);
    if (e.entity === "user") return `пользователь #${e.entityId}`;
    return e.entity;
  };
  return h(
    "div",
    { class: "page" },
    pageHead("Журнал", "Кто и что менял. Последние 200 записей."),
    tabs([["", "Всё"], ["listing", "Объявления"], ["lead", "Заявки"], ["user", "Пользователи"], ["settings", "Настройки"]], auditEntity, (v) => { auditEntity = v; shell.render(); }),
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        null,
        h("thead", null, h("tr", null, h("th", null, "Когда"), h("th", null, "Кто"), h("th", null, "Действие"), h("th", null, "Что"))),
        h("tbody", null, entries.map((e) => h("tr", null, h("td", { class: "nowrap small" }, fmtDateTime(e.at)), h("td", { class: "small" }, e.user ? e.user.name || e.user.email : "система"), h("td", null, AUDIT_LABELS[e.action] || e.action, h("div", { class: "small muted" }, describe(e))), h("td", { class: "small" }, link(e)))))
      )
    )
  );
}

// ---------- Настройки ----------

async function settings() {
  const { settings: s } = await get("/api/admin/settings");
  const metrika = h("input", { value: s.metrikaId, inputmode: "numeric", placeholder: "Например, 98765432", style: "max-width: 240px" });
  return h(
    "div",
    { class: "page" },
    pageHead("Настройки"),
    h(
      "form",
      {
        class: "card form",
        style: "max-width: 640px",
        onsubmit: (e) => {
          e.preventDefault();
          busy(e.submitter, async () => {
            try {
              await put("/api/admin/settings", { metrikaId: metrika.value });
              toast(metrika.value ? "Счётчик подключён — сайт начнёт отправлять данные в Метрику" : "Счётчик отключён");
            } catch (err) {
              toastError(err);
            }
          });
        },
      },
      h("h2", null, "Яндекс Метрика"),
      field("Номер счётчика", metrika, "Создайте счётчик на metrika.yandex.ru и вставьте его номер. Пусто — Метрика не подключается. Посетители увидят баннер о cookie."),
      h("div", { class: "form-actions" }, h("button", { class: "btn btn-primary", type: "submit" }, "Сохранить"))
    )
  );
}

shell = app({
  title: "Админка",
  user,
  fallback: "dashboard",
  nav: [
    { id: "dashboard", label: "Сводка" },
    { id: "moderation", label: "Модерация" },
    { id: "listings", label: "Объявления", match: ["listing", "new"] },
    { id: "leads", label: "Заявки", match: ["lead"] },
    { id: "users", label: "Пользователи" },
    { id: "stats", label: "Статистика" },
    { id: "audit", label: "Журнал" },
    { id: "settings", label: "Настройки" },
    { id: "profile", label: "Профиль" },
  ],
  routes: {
    dashboard,
    moderation,
    listings,
    new: () => listingEditor({ mode: "admin", user, basePath: "listing", onDone: refreshCounts }),
    "listing/:id": ({ params }) => listingEditor({ mode: "admin", id: params.id, user, basePath: "listing", onDone: refreshCounts }),
    leads: () => leadsList({ apiBase: "/api/admin/leads", basePath: "lead", sub: "Все заявки с сайта. Заявки на помещения сразу уходят их собственникам." }),
    "lead/:id": ({ params }) => leadDetail({ apiBase: "/api/admin/leads", id: params.id, admin: true, onDone: refreshCounts }),
    users,
    stats: () => statsView({ apiBase: "/api/admin/stats", siteWide: true }),
    audit,
    settings,
    profile: () => profileView({ providers }),
  },
});
refreshCounts();
