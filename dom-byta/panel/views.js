// Экраны, общие для кабинета собственника и админки.
import {
  h, mount, get, post, patch, del, api, busy, toast, toastError, confirmDialog,
  LABELS, badge, floorMark, fmtDate, fmtDateTime, fmtNum, fmtMoney, plural,
  pageHead, backLink, tabs, field,
} from "./core.js";

export const FLOOR_PLANS = [
  ["assets/img/floorplans/plan-a-rect.svg", "Прямоугольник"],
  ["assets/img/floorplans/plan-b-lshape.svg", "Г-образное"],
  ["assets/img/floorplans/plan-c-split.svg", "Две комнаты"],
  ["assets/img/floorplans/plan-d-strip.svg", "Вытянутое"],
  ["assets/img/floorplans/plan-e-suite.svg", "Блок кабинетов"],
  ["assets/img/floorplans/plan-f-entry.svg", "С тамбуром"],
  ["assets/img/floorplans/plan-g-nook.svg", "Небольшой кабинет"],
];
const TYPES = ["Офис", "Кабинет", "Ритейл", "Мастерская", "Студия", "Склад", "Общепит"];
const FIELD_LABELS = {
  title: "Название",
  type: "Тип",
  floor: "Этаж",
  areaM2: "Площадь",
  pricePerM2: "Цена за м²",
  description: "Описание",
  floorPlan: "Схема",
  photos: "Фото",
  ownerLabel: "Подпись",
};

const src = (url) => (url.startsWith("/") ? url : `/${url}`);
export const thumb = (url) => (url.startsWith("/uploads/") ? url.replace(/\.webp$/, "-thumb.webp") : src(url));

// ---------- Строка объявления в списке ----------

export function listingRow(l, href) {
  const cover = l.photos[0];
  const badges = [badge("moderation", l.moderation)];
  if (l.pendingChanges) badges.push(h("span", { class: "badge", dataset: { tone: "changes" } }, "Правки на модерации"));
  if (l.moderation === "published") badges.push(badge("availability", l.availability));
  return h(
    "a",
    { class: "row", href },
    floorMark(l.floor),
    cover ? h("img", { class: "row-thumb", src: thumb(cover), alt: "", loading: "lazy" }) : h("span", { class: "row-thumb" }),
    h(
      "span",
      { class: "row-main" },
      h("span", { class: "row-title" }, l.title),
      h(
        "span",
        { class: "row-meta" },
        h("span", null, `${fmtNum(l.areaM2)} м²`),
        l.pricePerM2 ? h("span", null, `${fmtMoney(l.pricePerM2)}/м²`) : null,
        l.type ? h("span", null, l.type) : null,
        h("span", null, l.code),
        l.ownerName !== undefined && l.ownerLabel ? h("span", null, l.ownerLabel) : null
      )
    ),
    h("span", { class: "row-side" }, h("span", { class: "badges" }, badges), h("span", { class: "muted small" }, `изм. ${fmtDate(l.updatedAt)}`))
  );
}

// ---------- Редактор объявления ----------
// mode: "landlord" — кабинет (правки опубликованного — через модерацию), "admin" — напрямую.

export async function listingEditor({ mode, id, user, basePath, onDone }) {
  const isAdmin = mode === "admin";
  const apiBase = isAdmin ? "/api/admin/listings" : "/api/my/listings";
  let listing = id ? (await get(`${apiBase}/${id}`)).listing : null;
  const landlords = isAdmin ? (await get("/api/admin/users?role=landlord")).users.filter((u) => u.status !== "blocked") : [];

  // Собственник видит в форме свою предлагаемую версию: живая + ожидающие правки.
  const values = listing
    ? { ...listing, ...(mode === "landlord" ? listing.pendingChanges || {} : {}) }
    : { floor: 8, photos: [], floorPlan: "", availability: "available", ownerLabel: user.company || user.name || "", demo: false, sort: 0 };
  let photos = [...values.photos];

  const root = h("div", { class: "page" });

  const inputs = {
    title: h("input", { value: values.title || "", required: true, maxlength: 200, placeholder: "Например: Офис 24 м² с окнами во двор" }),
    type: h("input", { value: values.type || "", list: "listing-types", maxlength: 60 }),
    floor: h("select", null, [1, 2, 3, 4, 5, 6, 7, 8].map((n) => h("option", { value: n, selected: n === values.floor }, `${n} этаж`))),
    areaM2: h("input", { type: "number", min: 1, step: 0.1, value: values.areaM2 ?? "", required: true, inputmode: "decimal" }),
    pricePerM2: h("input", { type: "number", min: 0, step: 10, value: values.pricePerM2 ?? "", inputmode: "numeric" }),
    description: h("textarea", { rows: 6, maxlength: 3000, value: values.description || "", placeholder: "Окна, отопление, вход, парковка, для какого бизнеса подойдёт" }),
    ownerLabel: h("input", { value: values.ownerLabel || "", maxlength: 120, placeholder: "Собственник этажа 3" }),
  };
  const adminInputs = isAdmin
    ? {
        demo: h("input", { type: "checkbox", checked: Boolean(values.demo) }),
        sort: h("input", { type: "number", value: values.sort ?? 0, step: 1 }),
        ownerId: h(
          "select",
          null,
          h("option", { value: "" }, "— без собственника (ведёт администратор) —"),
          landlords.map((u) => h("option", { value: u.id, selected: u.id === values.ownerId }, `${u.company || u.name || u.email}${u.status === "pending" ? " (не подтверждён)" : ""}`))
        ),
      }
    : {};

  const monthly = h("p", { class: "hint" });
  function updateMonthly() {
    const a = Number(inputs.areaM2.value);
    const p = Number(inputs.pricePerM2.value);
    monthly.textContent = a && p ? `На сайте: ≈ ${fmtMoney(Math.round(a * p))} в месяц` : "0 — «цена по запросу»";
  }
  inputs.areaM2.addEventListener("input", updateMonthly);
  inputs.pricePerM2.addEventListener("input", updateMonthly);
  updateMonthly();

  // Фото
  const photosEl = h("div", { class: "photos" });
  const fileInput = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp", multiple: true, onchange: () => uploadFiles(fileInput.files) });
  const addLabel = h("label", { class: "photo-add" }, fileInput, h("span", { "aria-hidden": "true" }, "+"), h("span", null, "Добавить фото"));
  function renderPhotos() {
    mount(
      photosEl,
      photos.map((url, i) =>
        h(
          "div",
          { class: "photo" },
          h("img", { src: thumb(url), alt: `Фото ${i + 1}` }),
          i === 0 ? h("span", { class: "photo-first" }, "Обложка") : null,
          h(
            "div",
            { class: "photo-tools" },
            i > 0 ? h("button", { type: "button", title: "Сдвинуть влево", "aria-label": "Сдвинуть влево", onclick: () => move(i, -1) }, "←") : null,
            i < photos.length - 1 ? h("button", { type: "button", title: "Сдвинуть вправо", "aria-label": "Сдвинуть вправо", onclick: () => move(i, 1) }, "→") : null,
            h("button", { type: "button", title: "Убрать", "aria-label": "Убрать фото", onclick: () => { photos.splice(i, 1); renderPhotos(); } }, "×")
          )
        )
      ),
      photos.length < 12 ? addLabel : null
    );
  }
  function move(i, d) {
    [photos[i], photos[i + d]] = [photos[i + d], photos[i]];
    renderPhotos();
  }
  async function uploadFiles(files) {
    if (!files.length) return;
    const fd = new FormData();
    [...files].slice(0, 12 - photos.length).forEach((f) => fd.append("file", f));
    addLabel.querySelector("span:last-child").textContent = "Загружаем…";
    try {
      const res = await api("POST", "/api/uploads", fd);
      photos.push(...res.files.map((f) => f.url));
    } catch (err) {
      toastError(err);
    }
    fileInput.value = "";
    addLabel.querySelector("span:last-child").textContent = "Добавить фото";
    renderPhotos();
  }
  renderPhotos();

  // Схема помещения
  const plans = h(
    "div",
    { class: "plans", role: "radiogroup", "aria-label": "Схема помещения" },
    h("label", null, h("input", { type: "radio", name: "plan", value: "", checked: !values.floorPlan }), "Без схемы"),
    FLOOR_PLANS.map(([url, name]) => h("label", { title: name }, h("input", { type: "radio", name: "plan", value: url, checked: values.floorPlan === url }), h("img", { src: src(url), alt: name })))
  );

  function collect() {
    const data = {
      title: inputs.title.value,
      type: inputs.type.value,
      floor: Number(inputs.floor.value),
      areaM2: inputs.areaM2.value === "" ? undefined : Number(inputs.areaM2.value),
      pricePerM2: Number(inputs.pricePerM2.value || 0),
      description: inputs.description.value,
      ownerLabel: inputs.ownerLabel.value,
      photos,
      floorPlan: plans.querySelector("input:checked")?.value || "",
    };
    if (isAdmin) {
      data.demo = adminInputs.demo.checked;
      data.sort = Number(adminInputs.sort.value || 0);
      data.ownerId = adminInputs.ownerId.value ? Number(adminInputs.ownerId.value) : null;
    }
    return data;
  }

  const errorEl = h("p", { class: "form-error", role: "alert" });

  async function save({ andSubmit = false, publish = false } = {}) {
    errorEl.textContent = "";
    const data = collect();
    try {
      if (!listing) {
        listing = (await post(apiBase, { ...data, availability: values.availability, publish })).listing;
      } else {
        // Собственнику отправляем только изменённые поля, чтобы не плодить пустые «правки».
        const changed = mode === "landlord" ? diffFields(data, values) : data;
        if (Object.keys(changed).length) listing = (await patch(`${apiBase}/${listing.id}`, changed)).listing;
      }
      if (andSubmit) listing = (await post(`${apiBase}/${listing.id}/submit`)).listing;
      toast(andSubmit ? "Отправлено на модерацию" : listing.pendingChanges && mode === "landlord" ? "Правки отправлены на модерацию" : "Сохранено");
      if (onDone) onDone();
      const target = `#${basePath}/${listing.id}`;
      if (location.hash === target) rerender();
      else location.hash = target;
    } catch (err) {
      errorEl.textContent = err.message;
    }
  }

  async function action(path, opts = {}) {
    try {
      if (opts.confirm && !(await confirmDialog(opts.confirm))) return;
      const body = opts.comment !== undefined ? { comment: opts.comment } : undefined;
      const res = await post(`${apiBase}/${listing.id}/${path}`, body);
      toast(opts.done || "Готово");
      listing = res.listing;
      if (onDone) onDone();
      rerender();
    } catch (err) {
      toastError(err);
    }
  }

  // Занятость: у существующего объявления применяется сразу, без модерации.
  function availabilityControl() {
    const group = h(
      "div",
      { class: "segmented", role: "group", "aria-label": "Занятость" },
      Object.entries(LABELS.availability).map(([value, label]) =>
        h(
          "button",
          {
            type: "button",
            "data-value": value,
            "aria-pressed": String((listing?.availability || values.availability) === value),
            onclick: async () => {
              if (!listing) {
                values.availability = value;
                group.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === value)));
                return;
              }
              try {
                listing = (await patch(`${apiBase}/${listing.id}`, { availability: value })).listing;
                group.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === value)));
                toast(listing.moderation === "published" ? `На сайте: «${label}»` : `Статус: «${label}»`);
              } catch (err) {
                toastError(err);
              }
            },
          },
          label
        )
      )
    );
    return h("div", { class: "field" }, h("span", { class: "label" }, "Занятость"), group, h("p", { class: "hint" }, "Меняется на сайте сразу, без модерации."));
  }

  function stateBanner() {
    if (!listing) {
      if (mode === "landlord" && user.status === "pending") {
        return h("div", { class: "banner" }, h("p", null, "Аккаунт ещё не подтверждён администратором. Черновик можно сохранить уже сейчас, а отправить на модерацию — после подтверждения."));
      }
      return null;
    }
    const m = listing.moderation;
    if (listing.pendingChanges) {
      return h(
        "div",
        { class: "banner" },
        h("div", null, h("strong", null, isAdmin ? "Собственник предлагает правки" : "Правки ждут модерации"), h("p", { class: "small" }, isAdmin ? "На сайте пока старая версия." : "На сайте пока старая версия. Можно продолжать править — отправится последняя версия."), diffView(listing)),
        isAdmin
          ? h("div", { class: "form-actions" }, h("button", { class: "btn btn-primary btn-sm", onclick: () => action("approve", { done: "Правки опубликованы" }) }, "Опубликовать правки"), h("button", { class: "btn btn-ghost btn-sm", onclick: () => reject() }, "Отклонить"))
          : h("button", { class: "btn btn-ghost btn-sm", onclick: () => action("discard-changes", { done: "Правки отменены", confirm: { title: "Отменить правки?", text: "Предложенные изменения удалятся, на сайте останется текущая версия.", confirm: "Отменить правки", danger: true } }) }, "Отменить правки")
      );
    }
    if (m === "rejected") {
      return h("div", { class: "banner", dataset: { tone: "error" } }, h("div", null, h("strong", null, "Отклонено администратором"), h("p", { class: "moderation-note" }, listing.moderationComment), mode === "landlord" ? h("p", { class: "small muted" }, "Исправьте и отправьте снова.") : null));
    }
    if (m === "pending") {
      return h(
        "div",
        { class: "banner" },
        h("div", null, h("strong", null, "На модерации"), h("p", { class: "small" }, isAdmin ? `Отправлено ${fmtDateTime(listing.submittedAt)}` : "Администратор проверит объявление и опубликует его. Мы пришлём уведомление.")),
        isAdmin ? h("div", { class: "form-actions" }, h("button", { class: "btn btn-primary btn-sm", onclick: () => action("approve", { done: "Опубликовано" }) }, "Опубликовать"), h("button", { class: "btn btn-ghost btn-sm", onclick: () => reject() }, "Отклонить")) : null
      );
    }
    if (m === "published" && listing.moderationComment && mode === "landlord") {
      return h("div", { class: "banner", dataset: { tone: "error" } }, h("div", null, h("strong", null, "Последние правки отклонены"), h("p", { class: "moderation-note" }, listing.moderationComment)));
    }
    return null;
  }

  async function reject() {
    const comment = await confirmDialog({
      title: "Отклонить",
      text: "Собственник получит уведомление с вашим комментарием.",
      confirm: "Отклонить",
      danger: true,
      withText: { label: "Что поправить", required: "Напишите, что поправить", placeholder: "Например: добавьте фото помещения при дневном свете" },
    });
    if (comment) action("reject", { comment, done: "Отклонено, собственник получит уведомление" });
  }

  function actionsCard() {
    const saveBtn = h("button", { class: "btn btn-primary btn-block", type: "button", onclick: (e) => busy(e.currentTarget, () => save()) }, listing ? (mode === "landlord" && listing.moderation === "published" ? "Отправить правки" : "Сохранить") : "Сохранить черновик");
    const items = [saveBtn];
    const m = listing?.moderation;
    if (mode === "landlord" && (!listing || m === "draft" || m === "rejected")) {
      items.push(h("button", { class: "btn btn-ghost btn-block", type: "button", disabled: user.status !== "active", title: user.status !== "active" ? "После подтверждения аккаунта" : undefined, onclick: (e) => busy(e.currentTarget, () => save({ andSubmit: true })) }, "Сохранить и отправить на модерацию"));
    }
    if (isAdmin && !listing) {
      items.push(h("button", { class: "btn btn-ghost btn-block", type: "button", onclick: (e) => busy(e.currentTarget, () => save({ publish: true })) }, "Сохранить и опубликовать"));
    }
    if (listing) {
      if (m === "archived") {
        items.push(isAdmin ? h("button", { class: "btn btn-ghost btn-block", onclick: () => action("unarchive", { done: "Снова на сайте" }) }, "Вернуть на сайт") : h("button", { class: "btn btn-ghost btn-block", onclick: () => action("restore", { done: "Возвращено в черновики" }) }, "Вернуть из архива"));
      } else {
        items.push(h("button", { class: "btn btn-ghost btn-block", onclick: () => action("archive", { done: "Убрано в архив", confirm: { title: "Убрать в архив?", text: m === "published" ? "Объявление пропадёт с сайта. Вернуть можно в любой момент." : "Объявление уйдёт в архив.", confirm: "В архив" } }) }, m === "published" ? "Снять с сайта" : "В архив"));
      }
      if (isAdmin || !listing.publishedAt) {
        items.push(
          h("button", {
            class: "btn btn-danger btn-block",
            onclick: async () => {
              if (!(await confirmDialog({ title: "Удалить объявление?", text: "Это нельзя отменить. Заявки по нему сохранятся.", confirm: "Удалить", danger: true }))) return;
              try {
                await del(`${apiBase}/${listing.id}`);
                toast("Удалено");
                location.hash = "listings";
                if (onDone) onDone();
              } catch (err) {
                toastError(err);
              }
            },
          }, "Удалить")
        );
      }
    }
    return h("div", { class: "card card-tight" }, h("div", { class: "form" }, items, errorEl));
  }

  function rerender() {
    const values2 = listing ? { ...listing, ...(mode === "landlord" ? listing.pendingChanges || {} : {}) } : values;
    Object.assign(values, values2);
    photos = [...values.photos];
    renderPhotos();
    mount(root, content());
  }

  function content() {
    const title = listing ? listing.title : "Новое объявление";
    const sub = listing
      ? [listing.code, isAdmin && listing.ownerName ? ` · ${listing.ownerName}` : "", listing.publishedAt ? ` · на сайте с ${fmtDate(listing.publishedAt)}` : ""].join("")
      : "Заполните карточку — так её увидят на сайте.";
    return [
      h("div", null, backLink("#listings", "Все объявления"), pageHead(title, sub, listing ? badge("moderation", listing.moderation) : null)),
      stateBanner(),
      h(
        "div",
        { class: "editor" },
        h(
          "form",
          { class: "form card", novalidate: true, onsubmit: (e) => { e.preventDefault(); save(); } },
          field("Название", inputs.title),
          h("div", { class: "field-row" }, field("Этаж", inputs.floor), field("Площадь, м²", inputs.areaM2), h("div", { class: "field" }, h("label", { for: "f-price" }, "Цена за м² в месяц, ₽"), Object.assign(inputs.pricePerM2, { id: "f-price" }), monthly)),
          field("Тип помещения", inputs.type),
          h("datalist", { id: "listing-types" }, TYPES.map((t) => h("option", { value: t }))),
          field("Описание", inputs.description),
          h("div", { class: "field" }, h("span", { class: "label" }, "Фото"), photosEl, h("p", { class: "hint" }, "JPG, PNG или WebP до 15 МБ. Первое фото — обложка карточки.")),
          h("div", { class: "field" }, h("span", { class: "label" }, "Схема помещения"), plans, h("p", { class: "hint" }, "Упрощённая схема формы помещения — не точный план.")),
          field("Подпись на карточке", inputs.ownerLabel, "Например, «Собственник этажа 3» или название компании."),
          isAdmin
            ? h(
                "div",
                { class: "card card-tight", style: "background: var(--color-bg)" },
                h("div", { class: "form" }, field("Собственник", adminInputs.ownerId, "Кому уходят заявки и кто правит объявление в кабинете."), field("Порядок на этаже", adminInputs.sort, "Меньше — выше."), h("label", { class: "check" }, adminInputs.demo, h("span", null, "Демо-объявление (на карточке будет пометка «Демо»)")))
              )
            : null,
          h("button", { type: "submit", hidden: true })
        ),
        h("div", { class: "editor-aside" }, h("div", { class: "card card-tight" }, availabilityControl()), actionsCard())
      ),
    ];
  }

  mount(root, content());
  return root;
}

function diffFields(data, base) {
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    const b = base[k];
    if (JSON.stringify(v ?? "") !== JSON.stringify(b ?? "")) out[k] = v;
  }
  return out;
}

function diffView(listing) {
  const rows = Object.entries(listing.pendingChanges).map(([k, v]) => {
    const before = listing[k];
    const show = (x) => (k === "photos" ? `${x.length} ${plural(x.length, "фото", "фото", "фото")}` : k === "floorPlan" ? (FLOOR_PLANS.find((p) => p[0] === x)?.[1] || "без схемы") : String(x ?? "—"));
    return h("div", { class: "diff-item" }, h("span", { class: "muted" }, FIELD_LABELS[k] || k), h("span", null, h("del", null, show(before)), " → ", h("ins", null, show(v))));
  });
  return h("div", { class: "diff", style: "margin-top: 8px" }, rows);
}

// ---------- Заявки ----------

const LEAD_TABS = [["", "Все"], ["new", "Новые"], ["in_progress", "В работе"], ["viewing", "Просмотр"], ["won", "Договор"], ["lost", "Отказ"], ["spam", "Спам"]];

export async function leadsList({ apiBase, basePath, title = "Заявки", sub }) {
  const root = h("div", { class: "page" });
  let status = sessionStorage.getItem(`leads:${apiBase}`) || "";
  async function load() {
    const { leads } = await get(`${apiBase}?status=${status}`);
    mount(
      root,
      pageHead(title, sub),
      tabs(LEAD_TABS, status, (v) => {
        status = v;
        sessionStorage.setItem(`leads:${apiBase}`, v);
        load().catch(toastError);
      }),
      leads.length
        ? h("div", { class: "rows" }, leads.map((l) => leadRow(l, `#${basePath}/${l.id}`)))
        : h("div", { class: "empty" }, h("strong", null, status ? "Здесь пусто" : "Заявок пока нет"), h("span", null, status ? "Заявок с таким статусом нет." : "Когда кто-то оставит заявку на сайте, она появится здесь, а мы пришлём уведомление."))
    );
  }
  await load();
  return root;
}

function leadRow(l, href) {
  const what = l.listingTitle ? `${l.listingTitle} · ${l.listingCode}` : LABELS.leadKind[l.kind];
  return h(
    "a",
    { class: "row row-lead", href },
    h("span", { class: "row-main" }, h("span", { class: "row-title" }, l.name, h("span", { class: "muted", style: "font-weight: 400" }, ` · ${l.phone}`)), h("span", { class: "row-meta" }, h("span", null, what), l.landlordName && !l.listingTitle ? h("span", null, `→ ${l.landlordName}`) : null, l.message ? h("span", null, l.message.slice(0, 80) + (l.message.length > 80 ? "…" : "")) : null)),
    h("span", { class: "row-side" }, badge("lead", l.status), h("span", { class: "muted small nowrap" }, fmtDateTime(l.createdAt)))
  );
}

export async function leadDetail({ apiBase, id, admin = false, onDone }) {
  const { lead, events } = await get(`${apiBase}/${id}`);
  const landlords = admin ? (await get("/api/admin/users?role=landlord&status=active")).users : [];
  const note = h("textarea", { rows: 3, value: lead.note, placeholder: "Видно только вам: договорённости, время просмотра" });
  const comment = h("input", { placeholder: "Например: созвонились, просмотр в пятницу" });
  let status = lead.status;
  const statusGroup = h(
    "div",
    { class: "tabs", role: "group", "aria-label": "Статус" },
    Object.entries(LABELS.lead).map(([v, label]) =>
      h("button", { type: "button", "aria-pressed": String(v === status), onclick: (e) => { status = v; statusGroup.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === e.currentTarget))); } }, label)
    )
  );
  const forward = admin
    ? h("select", null, h("option", { value: "" }, "— не передана —"), landlords.map((u) => h("option", { value: u.id, selected: u.id === lead.landlordId }, u.company || u.name || u.email)))
    : null;

  async function save(e) {
    await busy(e.currentTarget, async () => {
      try {
        const body = { status, note: note.value, comment: comment.value };
        if (admin) body.landlordId = forward.value ? Number(forward.value) : null;
        await patch(`${apiBase}/${lead.id}`, body);
        toast("Сохранено");
        if (onDone) onDone();
        location.hash = "leads";
      } catch (err) {
        toastError(err);
      }
    });
  }

  const tel = lead.phone.replace(/[^\d+]/g, "");
  return h(
    "div",
    { class: "page" },
    h("div", null, backLink("#leads", "Все заявки"), pageHead(lead.name, `${LABELS.leadKind[lead.kind]} · ${fmtDateTime(lead.createdAt)}`, badge("lead", lead.status))),
    h(
      "div",
      { class: "editor" },
      h(
        "div",
        { class: "form" },
        h(
          "div",
          { class: "card form" },
          h("div", { class: "contact-line" }, h("a", { class: "btn btn-primary", href: `tel:${tel}` }, `Позвонить: ${lead.phone}`), lead.email ? h("a", { class: "btn btn-ghost", href: `mailto:${lead.email}` }, lead.email) : null),
          lead.listingTitle ? h("p", null, "Помещение: ", h("strong", null, lead.listingTitle), h("span", { class: "muted" }, ` · ${lead.listingCode}`)) : null,
          lead.message ? h("div", { class: "lead-message" }, lead.message) : h("p", { class: "muted" }, "Без сообщения."),
          admin && lead.landlordName ? h("p", { class: "small muted" }, `Собственник: ${lead.landlordName}`) : null
        ),
        h(
          "div",
          { class: "card form" },
          h("h2", null, "Работа с заявкой"),
          h("div", { class: "field" }, h("span", { class: "label" }, "Статус"), statusGroup),
          field("Комментарий к смене статуса", comment),
          field("Заметка", note),
          admin ? field("Передать собственнику", forward, "Собственник получит уведомление и увидит заявку в кабинете.") : null,
          h("div", { class: "form-actions" }, h("button", { class: "btn btn-primary", type: "button", onclick: save }, "Сохранить"))
        )
      ),
      h(
        "div",
        { class: "editor-aside" },
        h(
          "div",
          { class: "card card-tight" },
          h("h3", null, "История"),
          h(
            "ol",
            { class: "timeline" },
            events.map((e) => h("li", null, h("span", { class: "muted" }, fmtDateTime(e.at)), h("span", null, e.from ? `${LABELS.lead[e.from]} → ${LABELS.lead[e.to]}` : "Заявка создана", e.by ? h("span", { class: "muted" }, ` · ${e.by}`) : null, e.comment ? h("div", { class: "small" }, e.comment) : null)))
          )
        )
      )
    )
  );
}

// ---------- Статистика ----------

export async function statsView({ apiBase, siteWide }) {
  const root = h("div", { class: "page" });
  let days = Number(sessionStorage.getItem("stats:days")) || 30;

  async function load() {
    const to = new Date();
    const from = new Date(Date.now() - (days - 1) * 86400000);
    const iso = (d) => d.toLocaleDateString("sv-SE", { timeZone: "Asia/Yekaterinburg" });
    const s = await get(`${apiBase}?from=${iso(from)}&to=${iso(to)}`);
    const t = s.totals;
    const kpis = siteWide
      ? [["Просмотры сайта", t.view], ["Посетители", t.visitor], ["Открытия карточек", t.open], ["Заявки", t.lead]]
      : [["Показы карточек", t.impression], ["Открытия карточек", t.open], ["Нажали «Оставить заявку»", t.cta], ["Заявки", t.lead]];
    mount(
      root,
      pageHead("Статистика", siteWide ? "Весь сайт. Без ботов, без персональных данных." : "По вашим объявлениям.", tabs([[7, "7 дней"], [30, "30 дней"], [90, "90 дней"]], days, (v) => { days = v; sessionStorage.setItem("stats:days", v); load().catch(toastError); })),
      h("div", { class: "grid grid-4" }, kpis.map(([label, value]) => h("div", { class: "card card-tight kpi" }, h("span", { class: "kpi-value" }, fmtNum(value)), h("span", { class: "kpi-label" }, label)))),
      h(
        "div",
        { class: "card" },
        h("div", { class: "toolbar" }, h("h2", { style: "margin: 0" }, "По дням"), h("div", { class: "legend" }, h("span", null, h("i", { style: `background: color-mix(in srgb, var(--color-fg-muted) 30%, transparent)` }), siteWide ? "просмотры" : "показы"), h("span", null, h("i", { style: "background: var(--color-accent)" }), "открытия карточек"), h("span", null, h("i", { style: "background: var(--color-primary); border-radius: 50%" }), "заявки"))),
        chart(s.days, siteWide ? "view" : "impression")
      ),
      h(
        "div",
        null,
        h("h2", { style: "margin-bottom: 12px" }, "По объявлениям"),
        s.listings.length
          ? h(
              "div",
              { class: "table-wrap" },
              h(
                "table",
                null,
                h("thead", null, h("tr", null, h("th", null, "Объявление"), h("th", { class: "num" }, "Показы"), h("th", { class: "num" }, "Открытия"), h("th", { class: "num" }, "Клик «Заявка»"), h("th", { class: "num" }, "Заявки"), h("th", { class: "num", title: "Заявки / открытия карточки" }, "Конверсия"))),
                h("tbody", null, s.listings.map((l) => h("tr", null, h("td", null, h("strong", null, l.title), h("div", { class: "small muted" }, `${l.floor} этаж · ${l.code}${l.moderation === "archived" ? " · в архиве" : ""}`)), h("td", { class: "num" }, fmtNum(l.impression)), h("td", { class: "num" }, fmtNum(l.open)), h("td", { class: "num" }, fmtNum(l.cta)), h("td", { class: "num" }, fmtNum(l.lead)), h("td", { class: "num" }, l.conversion === null ? "—" : `${l.conversion}%`))))
              )
            )
          : h("div", { class: "empty" }, h("span", null, "Статистика появится, когда объявления будут на сайте."))
      ),
      siteWide ? h("p", { class: "small muted" }, "Подробная аналитика по источникам и поведению — в Яндекс Метрике (номер счётчика задаётся в настройках).") : null
    );
  }
  await load();
  return root;
}

// Столбики: фон — просмотры/показы, поверх — открытия, точки — заявки.
function chart(days, baseMetric) {
  const W = 800;
  const H = 220;
  const pad = { l: 36, r: 8, t: 12, b: 24 };
  const max = Math.max(1, ...days.map((d) => Math.max(d[baseMetric], d.open)));
  const maxLead = Math.max(1, ...days.map((d) => d.lead));
  const bw = (W - pad.l - pad.r) / days.length;
  const y = (v) => H - pad.b - (v / max) * (H - pad.t - pad.b);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "chart");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `График за ${days.length} дней`);
  svg.setAttribute("preserveAspectRatio", "none");
  const el = (tag, attrs) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    svg.append(e);
    return e;
  };
  for (const v of [0, Math.round(max / 2), max]) {
    el("line", { class: "axis", x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) });
    el("text", { x: pad.l - 6, y: y(v) + 4, "text-anchor": "end" }).textContent = fmtNum(v);
  }
  const tip = h("div", { class: "chart-tip", hidden: true });
  document.body.append(tip);
  days.forEach((d, i) => {
    const x = pad.l + i * bw;
    const w = Math.max(1, bw * 0.7);
    el("rect", { class: "bar-views", x: x + (bw - w) / 2, y: y(d[baseMetric]), width: w, height: H - pad.b - y(d[baseMetric]), rx: 2 });
    el("rect", { class: "bar-opens", x: x + (bw - w * 0.5) / 2, y: y(d.open), width: w * 0.5, height: H - pad.b - y(d.open), rx: 2 });
    if (d.lead) el("circle", { class: "dot-leads", cx: x + bw / 2, cy: pad.t + 4 + (1 - d.lead / maxLead) * 30, r: 4 + Math.min(4, d.lead) });
    const step = Math.ceil(days.length / 8);
    if (i % step === 0) el("text", { x: x + bw / 2, y: H - 6, "text-anchor": "middle" }).textContent = fmtDate(d.day);
    const hit = el("rect", { x, y: 0, width: bw, height: H, fill: "transparent" });
    hit.addEventListener("pointerenter", (e) => {
      tip.hidden = false;
      tip.textContent = `${fmtDate(d.day)}: ${baseMetric === "view" ? "просмотры" : "показы"} ${d[baseMetric]}, открытия ${d.open}, заявки ${d.lead}`;
      tip.style.left = `${Math.min(e.clientX + 12, innerWidth - 260)}px`;
      tip.style.top = `${e.clientY - 36}px`;
    });
    hit.addEventListener("pointerleave", () => (tip.hidden = true));
  });
  // Подсказка живёт в body — убираем её вместе с графиком.
  new MutationObserver((_, obs) => {
    if (!svg.isConnected) {
      tip.remove();
      obs.disconnect();
    }
  }).observe(document.body, { childList: true, subtree: true });
  return svg;
}

// ---------- Профиль ----------

export async function profileView({ providers, onUserChange }) {
  let { user } = await get("/api/me");
  const root = h("div", { class: "page" });

  function render() {
    const name = h("input", { value: user.name, autocomplete: "name" });
    const phone = h("input", { value: user.phone, type: "tel", autocomplete: "tel" });
    const company = h("input", { value: user.company, autocomplete: "organization" });
    const nEmail = h("input", { type: "checkbox", checked: user.notify.email !== false, disabled: !user.email });
    const nTg = h("input", { type: "checkbox", checked: user.notify.telegram !== false, disabled: !user.identities.includes("telegram") });

    const main = h(
      "form",
      {
        class: "card form",
        onsubmit: (e) => {
          e.preventDefault();
          busy(e.submitter, async () => {
            try {
              user = (await patch("/api/me", { name: name.value, phone: phone.value, company: company.value, notify: { email: nEmail.checked, telegram: nTg.checked } })).user;
              toast("Сохранено");
              if (onUserChange) onUserChange(user);
            } catch (err) {
              toastError(err);
            }
          });
        },
      },
      h("h2", null, "О вас"),
      h("div", { class: "field-row" }, field("Имя", name), field("Телефон", phone)),
      user.role !== "tenant" ? field("Компания", company, "Если сдаёте от юрлица или ИП.") : null,
      h("h3", { style: "margin: 8px 0 0" }, "Уведомления о заявках"),
      h("label", { class: "check" }, nEmail, h("span", null, "На почту", user.email ? h("span", { class: "muted" }, ` — ${user.email}`) : h("span", { class: "muted" }, " — сначала добавьте почту"))),
      h("label", { class: "check" }, nTg, h("span", null, "В Telegram", user.identities.includes("telegram") ? null : h("span", { class: "muted" }, " — сначала привяжите Telegram ниже"))),
      h("div", { class: "form-actions" }, h("button", { class: "btn btn-primary", type: "submit" }, "Сохранить"))
    );

    mount(
      root,
      pageHead("Профиль", `${LABELS.role[user.role]} · ${LABELS.userStatus[user.status]}`),
      user.role === "tenant"
        ? h("div", { class: "banner" }, h("div", null, h("strong", null, "Сдаёте помещение в этом здании?"), h("p", { class: "small" }, "Запросите доступ собственника — после подтверждения администратором сможете размещать объявления.")), h("button", { class: "btn btn-primary btn-sm", onclick: async () => { try { user = (await post("/api/me/landlord-request")).user; toast("Запрос отправлен администратору"); location.reload(); } catch (err) { toastError(err); } } }, "Я собственник"))
        : null,
      h("div", { class: "grid grid-2", style: "align-items: start" }, main, h("div", { class: "form" }, emailCard(), passwordCard(), identitiesCard(), sessionsCard()))
    );
  }

  function emailCard() {
    const email = h("input", { type: "email", autocomplete: "email", value: user.email || "" });
    const code = h("input", { class: "code-input", inputmode: "numeric", maxlength: 6, "aria-label": "Код из письма" });
    const step2 = h("div", { class: "form", hidden: true }, h("p", { class: "small" }, "Мы отправили код на новый адрес."), code, h("button", { class: "btn btn-primary", type: "button", onclick: (e) => busy(e.currentTarget, async () => { try { user = (await post("/api/me/email/verify", { email: email.value, code: code.value })).user; toast("Почта подтверждена"); render(); } catch (err) { toastError(err); } }) }, "Подтвердить"));
    return h(
      "div",
      { class: "card card-tight form" },
      h("h3", { style: "margin: 0" }, "Почта"),
      field("Адрес", email, user.email ? "Смена — через код на новый адрес." : "Для входа по коду и уведомлений."),
      h("button", { class: "btn btn-ghost", type: "button", onclick: (e) => busy(e.currentTarget, async () => { try { await post("/api/me/email/request", { email: email.value }); step2.hidden = false; code.focus(); } catch (err) { toastError(err); } }) }, user.email ? "Сменить почту" : "Добавить почту"),
      step2
    );
  }

  function passwordCard() {
    const pass = h("input", { type: "password", autocomplete: "new-password", minlength: 8 });
    return h(
      "div",
      { class: "card card-tight form" },
      h("h3", { style: "margin: 0" }, "Пароль"),
      field(user.hasPassword ? "Новый пароль" : "Задать пароль", pass, "Не короче 8 символов. Входить по коду из письма можно и без пароля."),
      h("button", { class: "btn btn-ghost", type: "button", disabled: !user.email, onclick: (e) => busy(e.currentTarget, async () => { try { await post("/api/auth/password", { password: pass.value }); user.hasPassword = true; pass.value = ""; toast("Пароль сохранён"); } catch (err) { toastError(err); } }) }, "Сохранить пароль")
    );
  }

  function identitiesCard() {
    const list = h("div", { class: "form" });
    for (const p of ["telegram", "yandex", "vk"]) {
      const linked = user.identities.includes(p);
      const available = p === "telegram" ? Boolean(providers.telegram) : Boolean(providers[p]);
      if (!linked && !available) continue;
      let control;
      if (linked) {
        control = h("button", { class: "btn btn-quiet btn-sm", onclick: async () => { if (!(await confirmDialog({ title: `Отвязать ${LABELS.provider[p]}?`, confirm: "Отвязать", danger: true }))) return; try { await del(`/api/auth/identities/${p}`); user.identities = user.identities.filter((x) => x !== p); render(); } catch (err) { toastError(err); } } }, "Отвязать");
      } else if (p === "telegram") {
        control = h("div");
        window.onTelegramAuth = async (tg) => {
          try {
            user = (await post("/api/auth/telegram", { telegram: tg })).user;
            toast("Telegram привязан — уведомления будут приходить туда");
            render();
          } catch (err) {
            toastError(err);
          }
        };
        const s = document.createElement("script");
        s.async = true;
        s.src = "https://telegram.org/js/telegram-widget.js?22";
        Object.assign(s.dataset, { telegramLogin: providers.telegram, size: "medium", onauth: "onTelegramAuth(user)", requestAccess: "write" });
        control.append(s);
      } else {
        control = h("a", { class: "btn btn-ghost btn-sm", href: `/api/auth/${p}/start` }, "Привязать");
      }
      list.append(h("div", { class: "toolbar" }, h("span", null, h("strong", null, LABELS.provider[p]), linked ? h("span", { class: "muted small" }, " · привязан") : null), control));
    }
    if (!list.children.length) return null;
    return h("div", { class: "card card-tight form" }, h("h3", { style: "margin: 0" }, "Вход через сервисы"), list);
  }

  function sessionsCard() {
    return h(
      "div",
      { class: "card card-tight form" },
      h("h3", { style: "margin: 0" }, "Устройства"),
      h("p", { class: "small muted" }, "Если входили с чужого компьютера — выйдите везде."),
      h("button", { class: "btn btn-ghost", onclick: async () => { if (!(await confirmDialog({ title: "Выйти на всех устройствах?", text: "Потребуется войти заново, в том числе здесь.", confirm: "Выйти везде" }))) return; await del("/api/me/sessions"); location.href = "/login/"; } }, "Выйти на всех устройствах")
    );
  }

  render();
  return root;
}
