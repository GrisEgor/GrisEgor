import { h, get, session, app, pageHead, tabs, toastError } from "./core.js";
import { listingRow, listingEditor, leadsList, leadDetail, statsView, profileView } from "./views.js";

const { user, providers } = await session(["landlord", "tenant"]);

if (user.role === "tenant") {
  // Кабинет арендатора (избранное, документы, заявки в эксплуатацию) — на этапе 2.
  app({
    title: "Кабинет",
    user,
    fallback: "profile",
    nav: [{ id: "profile", label: "Профиль" }],
    routes: { profile: () => profileView({ providers }) },
  });
} else {
  let shell;
  const refreshCounts = async () => {
    try {
      const { leads } = await get("/api/my/leads?status=new");
      shell.setCount("leads", leads.length);
    } catch {
      // Счётчик в меню — не главное.
    }
  };

  const banner = () =>
    user.status === "pending"
      ? h("div", { class: "banner" }, h("p", null, h("strong", null, "Аккаунт ждёт подтверждения администратором. "), "Пока можно готовить черновики объявлений — отправить их на модерацию получится после подтверждения."))
      : null;

  let showArchived = false;
  async function listings() {
    const { listings } = await get(`/api/my/listings${showArchived ? "?archived=1" : ""}`);
    const newBtn = h("a", { class: "btn btn-primary", href: "#new" }, "Новое объявление");
    return h(
      "div",
      { class: "page" },
      pageHead("Мои объявления", "Занятость меняется сразу, остальные правки опубликованного объявления проходят модерацию.", newBtn),
      banner(),
      tabs([[false, "Действующие"], [true, "С архивом"]], showArchived, (v) => {
        showArchived = v;
        shell.render();
      }),
      listings.length
        ? h("div", { class: "rows" }, listings.map((l) => listingRow(l, `#listing/${l.id}`)))
        : h("div", { class: "empty" }, h("strong", null, "Объявлений пока нет"), h("span", null, "Добавьте первое помещение — после модерации оно появится на сайте."), h("a", { class: "btn btn-primary", href: "#new" }, "Добавить помещение"))
    );
  }

  shell = app({
    title: "Кабинет собственника",
    user,
    fallback: "listings",
    nav: [
      { id: "listings", label: "Объявления", match: ["listing", "new"] },
      { id: "leads", label: "Заявки", match: ["lead"] },
      { id: "stats", label: "Статистика" },
      { id: "profile", label: "Профиль" },
    ],
    routes: {
      listings,
      new: () => listingEditor({ mode: "landlord", user, basePath: "listing" }),
      "listing/:id": ({ params }) => listingEditor({ mode: "landlord", id: params.id, user, basePath: "listing" }),
      leads: () => leadsList({ apiBase: "/api/my/leads", basePath: "lead", sub: "Заявки на ваши помещения с сайта." }),
      "lead/:id": ({ params }) => leadDetail({ apiBase: "/api/my/leads", id: params.id, onDone: refreshCounts }),
      stats: () => statsView({ apiBase: "/api/my/stats", siteWide: false }),
      profile: () => profileView({ providers }),
    },
  });
  refreshCounts().catch(toastError);
}
