import { h, mount, get, post, busy, field } from "./core.js";

const root = document.getElementById("app");
const params = new URLSearchParams(location.search);
const next = params.get("next") || "";

const ERRORS = {
  consent: "Вы входите впервые — выберите, кто вы, и подтвердите согласие, затем нажмите вход ещё раз.",
  state: "Вход не завершился — попробуйте ещё раз.",
  denied: "Вход отменён.",
  provider: "Не удалось войти через внешний сервис. Попробуйте ещё раз или войдите по почте.",
  identity_taken: "Этот аккаунт уже привязан к другому пользователю.",
  blocked: "Аккаунт заблокирован. Напишите администратору сайта.",
};

const state = {
  step: "email", // email | code | password | register
  email: "",
  code: "",
  role: params.get("role") === "landlord" ? "landlord" : "tenant",
  resume: null, // что повторить после регистрации: { type: "email" | "telegram" | "oauth", ... }
  error: ERRORS[params.get("error")] || "",
  providers: {},
  devOutbox: false,
};

if (params.get("error") === "consent") {
  state.step = "register";
  state.resume = { type: "oauth", provider: sessionStorage.getItem("dbOauthProvider") || "" };
}

function go(res) {
  location.href = next || res.redirect || "/cabinet/";
}

function errorLine() {
  return h("p", { class: "form-error", role: "alert" }, state.error);
}

function set(patch) {
  Object.assign(state, patch);
  render();
}

// ---------- Шаги ----------

function emailStep() {
  const input = h("input", { type: "email", name: "email", autocomplete: "email", required: true, value: state.email, placeholder: "you@example.ru" });
  const btn = h("button", { class: "btn btn-primary btn-lg btn-block", type: "submit" }, "Получить код");
  const form = h(
    "form",
    {
      class: "form",
      novalidate: true,
      onsubmit: (e) => {
        e.preventDefault();
        busy(btn, async () => {
          try {
            await post("/api/auth/email/request", { email: input.value });
            set({ step: "code", email: input.value.trim().toLowerCase(), error: "" });
          } catch (err) {
            if (err.code === "too_soon") return set({ step: "code", email: input.value.trim().toLowerCase(), error: "" });
            set({ email: input.value, error: err.message });
          }
        });
      },
    },
    field("Почта", input, "Пришлём код для входа. Пароль заводить не обязательно."),
    errorLine(),
    btn,
    h("button", { class: "btn btn-quiet", type: "button", onclick: () => set({ step: "password", email: input.value, error: "" }) }, "Войти с паролем")
  );
  return [h("h2", null, "Вход"), form, socials()];
}

function codeStep() {
  const input = h("input", { class: "code-input", inputmode: "numeric", autocomplete: "one-time-code", maxlength: 6, pattern: "\\d{6}", required: true, "aria-label": "Код из письма" });
  const btn = h("button", { class: "btn btn-primary btn-lg btn-block", type: "submit" }, "Войти");
  const resend = h("button", { class: "btn btn-quiet", type: "button", disabled: true }, "Отправить код ещё раз");
  let left = 60;
  const timer = setInterval(() => {
    left -= 1;
    resend.textContent = left > 0 ? `Отправить ещё раз через ${left} с` : "Отправить код ещё раз";
    if (left <= 0) {
      resend.disabled = false;
      clearInterval(timer);
    }
  }, 1000);
  resend.addEventListener("click", () =>
    busy(resend, async () => {
      try {
        await post("/api/auth/email/request", { email: state.email });
        clearInterval(timer);
        set({ error: "" });
      } catch (err) {
        set({ error: err.message });
      }
    })
  );
  input.addEventListener("input", () => {
    input.value = input.value.replace(/\D/g, "").slice(0, 6);
    if (input.value.length === 6) form.requestSubmit();
  });
  const form = h(
    "form",
    {
      class: "form",
      novalidate: true,
      onsubmit: (e) => {
        e.preventDefault();
        busy(btn, () => verifyEmail(input.value));
      },
    },
    h("p", null, "Код отправлен на ", h("strong", null, state.email), ". Проверьте папку «Спам», если письма нет."),
    state.devOutbox
      ? h("p", { class: "banner small" }, "Локальный режим: письма не отправляются. ", h("a", { href: "/api/dev/outbox", target: "_blank" }, "Посмотреть код"))
      : null,
    input,
    errorLine(),
    btn,
    h("div", { class: "form-actions" }, resend, h("button", { class: "btn btn-quiet", type: "button", onclick: () => { clearInterval(timer); set({ step: "email", error: "" }); } }, "Другая почта"))
  );
  setTimeout(() => input.focus());
  return [h("h2", null, "Введите код"), form];
}

async function verifyEmail(code, reg = {}) {
  try {
    const res = await post("/api/auth/email/verify", { email: state.email, code, next, ...reg });
    go(res);
  } catch (err) {
    if (err.code === "registration_required") {
      return set({ step: "register", code, resume: { type: "email" }, error: "" });
    }
    set({ error: err.message });
  }
}

function passwordStep() {
  const email = h("input", { type: "email", autocomplete: "email", required: true, value: state.email });
  const password = h("input", { type: "password", autocomplete: "current-password", required: true });
  const btn = h("button", { class: "btn btn-primary btn-lg btn-block", type: "submit" }, "Войти");
  const form = h(
    "form",
    {
      class: "form",
      novalidate: true,
      onsubmit: (e) => {
        e.preventDefault();
        busy(btn, async () => {
          try {
            go(await post("/api/auth/password/login", { email: email.value, password: password.value, next }));
          } catch (err) {
            set({ email: email.value, error: err.message });
          }
        });
      },
    },
    field("Почта", email),
    field("Пароль", password, "Забыли пароль? Войдите по коду из письма и задайте новый в профиле."),
    errorLine(),
    btn,
    h("button", { class: "btn btn-quiet", type: "button", onclick: () => set({ step: "email", email: email.value, error: "" }) }, "Войти по коду из письма")
  );
  return [h("h2", null, "Вход с паролем"), form, socials()];
}

function registerStep() {
  const roleChoice = h(
    "div",
    { class: "choice", role: "radiogroup", "aria-label": "Кто вы" },
    [
      ["landlord", "Я собственник", "Сдаю помещение в этом здании"],
      ["tenant", "Я арендатор", "Ищу или уже снимаю помещение"],
    ].map(([value, title, sub]) =>
      h("label", null, h("input", { type: "radio", name: "role", value, checked: state.role === value, onchange: () => (state.role = value) }), h("strong", null, title), h("span", null, sub))
    )
  );
  const name = h("input", { autocomplete: "name", required: true });
  const phone = h("input", { type: "tel", autocomplete: "tel", inputmode: "tel" });
  const consent = h("input", { type: "checkbox", required: true });
  const btn = h("button", { class: "btn btn-primary btn-lg btn-block", type: "submit" }, state.resume?.type === "oauth" ? "Продолжить" : "Создать аккаунт");

  const form = h(
    "form",
    {
      class: "form",
      novalidate: true,
      onsubmit: (e) => {
        e.preventDefault();
        if (!consent.checked) return set({ error: "Без согласия на обработку персональных данных аккаунт создать нельзя." });
        const reg = { role: state.role, name: name.value, phone: phone.value, consent: true };
        busy(btn, async () => {
          const r = state.resume || {};
          if (r.type === "email") return verifyEmail(state.code, reg);
          if (r.type === "telegram") return telegramLogin(r.data, reg);
          if (r.type === "oauth" && r.provider) return oauth(r.provider, reg);
          set({ step: "email", error: "" });
        });
      },
    },
    h("div", { class: "field" }, h("span", { class: "label" }, "Кто вы"), roleChoice),
    field("Имя", name),
    field("Телефон", phone, "Необязательно. Увидит только администратор сайта."),
    h(
      "label",
      { class: "check" },
      consent,
      h("span", null, "Соглашаюсь на обработку персональных данных по ", h("a", { href: "/privacy/", target: "_blank" }, "политике конфиденциальности"))
    ),
    errorLine(),
    btn,
    h("button", { class: "btn btn-quiet", type: "button", onclick: () => set({ step: "email", resume: null, error: "" }) }, "Назад")
  );
  return [h("h2", null, "Вы здесь впервые"), h("p", { class: "muted" }, "Расскажите о себе — это займёт полминуты."), form];
}

// ---------- Внешние сервисы ----------

function oauth(provider, reg = {}) {
  sessionStorage.setItem("dbOauthProvider", provider);
  const q = new URLSearchParams({ next });
  if (reg.consent) {
    q.set("consent", "1");
    q.set("role", reg.role);
    if (reg.name) q.set("name", reg.name);
    if (reg.phone) q.set("phone", reg.phone);
  }
  location.href = `/api/auth/${provider}/start?${q}`;
}

async function telegramLogin(data, reg = {}) {
  try {
    go(await post("/api/auth/telegram", { telegram: data, next, ...reg }));
  } catch (err) {
    if (err.code === "registration_required") return set({ step: "register", resume: { type: "telegram", data }, error: "" });
    set({ error: err.message });
  }
}

const icons = {
  yandex: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#FC3F1D"/><path fill="#fff" d="M13.3 18.5h2.1V5.5h-3c-3.1 0-4.7 1.6-4.7 3.9 0 1.9.9 3 2.6 4.2l-3 4.9h2.3l3.3-5.4-1.1-.8c-1.4-.9-2-1.7-2-3.1 0-1.3.9-2.2 2.6-2.2h.9v11.5z"/></svg>',
  vk: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="6" fill="#0077FF"/><path fill="#fff" d="M12.8 17c-5 0-7.8-3.4-7.9-9.1h2.5c.1 4.2 1.9 5.9 3.4 6.3V7.9h2.3v3.6c1.4-.2 2.9-1.8 3.4-3.6h2.3c-.4 2.2-2 3.8-3.2 4.5 1.2.6 3 2 3.7 4.6h-2.6c-.5-1.7-1.9-3-3.6-3.2V17h-.3z"/></svg>',
};

function socials() {
  const p = state.providers;
  if (!p.telegram && !p.yandex && !p.vk) return null;
  const list = h("div", { class: "socials" });
  if (p.telegram) {
    const holder = h("div", { class: "tg-widget" });
    window.onTelegramAuth = (user) => telegramLogin(user);
    const s = document.createElement("script");
    s.async = true;
    s.src = "https://telegram.org/js/telegram-widget.js?22";
    s.dataset.telegramLogin = p.telegram;
    s.dataset.size = "large";
    s.dataset.radius = "14";
    s.dataset.onauth = "onTelegramAuth(user)";
    // Разрешение писать в личку — для уведомлений о заявках.
    s.dataset.requestAccess = "write";
    holder.append(s);
    list.append(holder);
  }
  if (p.yandex) list.append(socialButton("yandex", "Войти с Яндекс ID"));
  if (p.vk) list.append(socialButton("vk", "Войти через VK ID"));
  return [h("div", { class: "divider" }, "или"), list];
}

function socialButton(provider, label) {
  const b = h("button", { class: "btn btn-ghost btn-social btn-block", type: "button", onclick: () => oauth(provider) }, label);
  b.insertAdjacentHTML("afterbegin", icons[provider]);
  return b;
}

// ---------- Отрисовка ----------

function render() {
  const view = { email: emailStep, code: codeStep, password: passwordStep, register: registerStep }[state.step];
  mount(root, view());
}

(async () => {
  try {
    const me = await get("/api/auth/me");
    if (me.user) return (location.href = next || (me.user.role === "admin" ? "/admin/" : "/cabinet/"));
    state.providers = me.providers;
    state.devOutbox = Boolean(me.devOutbox);
  } catch {
    // Покажем форму и без списка провайдеров.
  }
  render();
})();
