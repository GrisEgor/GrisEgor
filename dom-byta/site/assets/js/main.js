(function () {
  "use strict";

  var prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var STATUS_LABEL = { available: "Свободно", reserved: "На просмотре", occupied: "Сдано", unlisted: "Нет объявлений" };
  var listingsById = {};

  /* ---------- Footer year ---------- */
  var yearEl = document.querySelector("[data-year]");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  /* ---------- Mobile nav ---------- */
  var header = document.querySelector("[data-header]");
  var navToggle = document.querySelector(".nav-toggle");
  if (header && navToggle) {
    navToggle.addEventListener("click", function () {
      var isOpen = header.classList.toggle("is-open");
      navToggle.setAttribute("aria-expanded", String(isOpen));
    });
    header.querySelectorAll(".nav-mobile a").forEach(function (link) {
      link.addEventListener("click", function () {
        header.classList.remove("is-open");
        navToggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  /* ---------- Mobile floating CTA: show once the hero's own CTA scrolls out of view ---------- */
  var mobileCtaBar = document.querySelector("[data-mobile-cta]");
  var heroActionsEl = document.querySelector(".hero-actions");
  if (mobileCtaBar && heroActionsEl && "IntersectionObserver" in window) {
    var ctaObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        mobileCtaBar.classList.toggle("is-visible", !entry.isIntersecting);
      });
    }, { threshold: 0 });
    ctaObserver.observe(heroActionsEl);
  }

  /* ---------- Data-driven content: floors + listings ---------- */
  // Запрос выполняется один раз за жизнь страницы, результат переиспользуется.
  // Раньше каждое переключение этажа в фильтре вызывало loadListingsData()
  // заново, а Netlify отдаёт статику с "max-age=0, must-revalidate" — то есть
  // на каждый клик уходил сетевой запрос, и фильтр заметно тормозил.
  var listingsDataPromise = null;
  var statsQueue = [];

  function fetchJson(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error("bad status " + res.status);
      return res.json();
    });
  }

  // Живые объявления — из API (их ведут собственники в кабинетах). Если сервер
  // недоступен, показываем снимок data/listings.json, а без него — копию в index.html.
  function loadListingsData() {
    if (listingsDataPromise) return listingsDataPromise;
    listingsDataPromise = fetchJson("/api/listings")
      .catch(function (err) {
        console.warn("API объявлений недоступно, берём data/listings.json:", err);
        return fetchJson("data/listings.json");
      })
      .catch(function (err) {
        // Открыто как file://, оффлайн, или сервер не отдаёт JSON — используем
        // встроенную резервную копию из index.html (см. #listings-fallback).
        console.warn("Не удалось загрузить data/listings.json, используем встроенную копию:", err);
        var fallback = document.getElementById("listings-fallback");
        if (!fallback) throw err;
        return JSON.parse(fallback.textContent);
      });
    return listingsDataPromise;
  }

  loadListingsData().then(function (data) { renderSite(data); });

  function renderSite(data) {
    var listings = data.listings || [];
    var totalFloors = (data.building && data.building.floors) || 8;

    listings.forEach(function (l) { listingsById[l.id] = l; });

    renderFloorStack(listings, totalFloors);
    renderHeroStats(listings);
    renderFilters(listings, totalFloors);

    // По умолчанию открыт самый верхний этаж, где есть объявления (8-й) —
    // площади собственника сайта. Ищем сверху вниз, а не берём число 8
    // жёстко: если объявления с верхнего этажа однажды снимут, фильтр
    // откроется на следующем занятом, а не на пустом списке.
    var defaultFilter = "all";
    for (var f = totalFloors; f >= 1; f--) {
      if (listings.some(function (l) { return l.floor === f; })) { defaultFilter = String(f); break; }
    }
    setActiveFilter(defaultFilter);

    populateRentFloorSelect(listings);
    initReveals();
  }

  function statusForFloor(listings, floor) {
    var onFloor = listings.filter(function (l) { return l.floor === floor; });
    if (onFloor.some(function (l) { return l.status === "available"; })) return "available";
    if (onFloor.some(function (l) { return l.status === "reserved"; })) return "reserved";
    if (onFloor.length) return "occupied";
    return "unlisted";
  }

  function renderFloorStack(listings, totalFloors) {
    var stack = document.querySelector("[data-floor-stack]");
    if (!stack) return;
    var rows = [];
    // Сверху вниз: 8-й этаж первым, 1-й последним — как в здании. Порядок
    // задаётся здесь, а не переворотом в CSS, иначе мобильная раскладка
    // (горизонтальная лента) показывала бы этажи в обратную сторону.
    for (var f = totalFloors; f >= 1; f--) {
      var status = statusForFloor(listings, f);
      rows.push(
        '<button class="floor-row" type="button" data-status="' + status + '" data-floor="' + f + '" aria-label="Этаж ' + f + ": " + STATUS_LABEL[status] + '">' +
          '<span class="floor-row__num">' + f + "</span>" +
          '<span class="floor-row__bar"><span></span></span>' +
          '<span class="floor-row__label">' + STATUS_LABEL[status] + "</span>" +
        "</button>"
      );
    }
    stack.innerHTML = rows.join("");
    stack.querySelectorAll(".floor-row").forEach(function (row) {
      row.addEventListener("click", function () {
        var floor = row.getAttribute("data-floor");
        document.getElementById("listings").scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth" });
        setActiveFilter(floor);
      });
    });
  }

  function renderHeroStats(listings) {
    var availableEl = document.querySelector('[data-stat="available"]');
    var ownersEl = document.querySelector('[data-stat="owners"]');
    if (availableEl) {
      availableEl.textContent = String(listings.filter(function (l) { return l.status === "available"; }).length);
    }
    if (ownersEl) {
      var owners = new Set(listings.map(function (l) { return l.owner; }));
      ownersEl.textContent = String(owners.size);
    }
  }

  function renderFilters(listings, totalFloors) {
    var wrap = document.querySelector("[data-filters]");
    if (!wrap) return;
    var floors = [];
    // Тот же порядок, что и у схемы этажей выше: 8 → 1.
    for (var f = totalFloors; f >= 1; f--) {
      if (listings.some(function (l) { return l.floor === f; })) floors.push(f);
    }
    var buttons = floors.map(function (f) {
      return '<button class="filter-chip" type="button" data-filter="' + f + '">Этаж ' + f + "</button>";
    });
    wrap.insertAdjacentHTML("beforeend", buttons.join(""));

    wrap.querySelectorAll(".filter-chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        setActiveFilter(chip.getAttribute("data-filter"));
      });
    });
  }

  function setActiveFilter(filterValue) {
    var wrap = document.querySelector("[data-filters]");
    if (!wrap) return;
    wrap.querySelectorAll(".filter-chip").forEach(function (chip) {
      chip.classList.toggle("is-active", chip.getAttribute("data-filter") === String(filterValue));
    });
    loadListingsData().then(function (data) {
      renderListingGrid(data.listings || [], filterValue);
    });
  }

  function renderListingGrid(listings, filterValue) {
    var grid = document.querySelector("[data-listing-grid]");
    var emptyMsg = document.querySelector("[data-listing-empty]");
    if (!grid) return;

    var filtered = filterValue === "all" ? listings : listings.filter(function (l) { return String(l.floor) === String(filterValue); });

    if (!filtered.length) {
      grid.innerHTML = "";
      if (emptyMsg) emptyMsg.hidden = false;
      return;
    }
    if (emptyMsg) emptyMsg.hidden = true;

    grid.innerHTML = filtered.map(function (l) {
      var price = l.pricePerM2 && l.areaM2 ? Math.round(l.pricePerM2 * l.areaM2) : null;
      var canApply = l.status !== "occupied";
      return (
        '<article class="listing-card" data-anim="fade-up">' +
          renderCarousel(l) +
          '<div class="listing-card__body">' +
            '<div class="listing-card__top">' +
              '<span class="listing-card__floor">Этаж ' + l.floor + "</span>" +
              '<span class="badge" data-status="' + l.status + '">' + STATUS_LABEL[l.status] + "</span>" +
            "</div>" +
            "<h3>" + escapeHtml(l.title) + "</h3>" +
            '<div class="listing-card__meta">' +
              "<span>" + l.areaM2 + " м²</span>" +
              "<span>" + escapeHtml(l.type) + "</span>" +
            "</div>" +
            '<p class="listing-card__desc">' + escapeHtml(l.description) + "</p>" +
            (price ? '<div class="listing-card__price">' + price.toLocaleString("ru-RU") + " ₽<small> / мес., пример</small></div>" : "") +
            '<div class="listing-card__actions">' +
              '<button type="button" class="btn btn-ghost" data-listing-details="' + escapeHtml(l.id) + '">Подробнее</button>' +
              (canApply ? '<a class="btn btn-primary" href="#contacts" data-listing-cta="' + escapeHtml(l.id) + '">Оставить заявку</a>' : "") +
            "</div>" +
          "</div>" +
        "</article>"
      );
    }).join("");

    grid.querySelectorAll("[data-listing-cta]").forEach(function (link) {
      link.addEventListener("click", function () {
        var listing = listingsById[link.getAttribute("data-listing-cta")];
        if (listing) {
          setRentFormListing(listing);
          track("cta", listing.id);
        }
      });
    });

    grid.querySelectorAll("[data-listing-details]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var listing = listingsById[btn.getAttribute("data-listing-details")];
        if (listing) {
          openListingModal(listing, btn);
          track("open", listing.id);
        }
      });
    });

    initCarousels(grid);
    observeImpressions(grid);

    if (window.gsap && !prefersReducedMotion) {
      gsap.fromTo(grid.querySelectorAll(".listing-card"),
        { opacity: 0, y: 16 },
        { opacity: 1, y: 0, duration: 0.4, stagger: 0.05, ease: "power2.out" }
      );
    }
  }

  /* ---------- Media carousel: floor plan + photos per card ----------
     Most listings on the site are demo content (l.demo defaults to true
     when the field is absent, so existing entries need no changes) and
     get an explicit "Демо" badge plus alt text saying so. Listings with
     "demo": false (real premises, e.g. the floor 8 offices derived from
     an actual BTI plan) skip that badge — their floor plan is still a
     simplified, non-exact schematic (same caveat as always), and their
     photos may be the shared "photo coming soon" placeholder rather than
     demo stock, so neither should be labelled "Демо". */
  function renderCarousel(l) {
    var isDemo = l.demo !== false;
    var slides = [];
    if (l.floorPlan) {
      slides.push({
        src: l.floorPlan,
        plan: true,
        alt: (isDemo ? "Демо-планировка" : "Схематичный план") + " помещения — этаж " + l.floor + ", ориентировочная схема, не точный чертёж"
      });
    }
    (l.photos || []).forEach(function (src) {
      slides.push({
        src: src,
        plan: false,
        alt: isDemo ? "Демо-фото для примера — не реальное фото помещения" : "Фото помещения ещё не добавлено"
      });
    });
    if (!slides.length) return "";

    var slidesHtml = slides.map(function (s) {
      return (
        '<div class="carousel__slide' + (s.plan ? " carousel__slide--plan" : "") + '">' +
          '<img src="' + escapeHtml(s.src) + '" alt="' + escapeHtml(s.alt) + '" loading="lazy" decoding="async">' +
        "</div>"
      );
    }).join("");

    var controls = "";
    if (slides.length > 1) {
      var dots = slides.map(function (_, i) {
        return '<button class="carousel__dot' + (i === 0 ? " is-active" : "") + '" type="button" data-index="' + i + '" aria-label="Слайд ' + (i + 1) + " из " + slides.length + '"></button>';
      }).join("");
      controls =
        '<button class="carousel__nav carousel__nav--prev" type="button" data-carousel-prev aria-label="Предыдущее изображение">‹</button>' +
        '<button class="carousel__nav carousel__nav--next" type="button" data-carousel-next aria-label="Следующее изображение">›</button>' +
        '<div class="carousel__dots" role="tablist" aria-label="Слайды помещения">' + dots + "</div>";
    }

    return (
      '<div class="carousel' + (slides.length > 1 ? " carousel--multi" : "") + '" data-carousel role="group" aria-roledescription="carousel" aria-label="' + (isDemo ? "Планировка и фото помещения (демо)" : "Планировка и фото помещения") + '">' +
        '<div class="carousel__track" data-carousel-track>' + slidesHtml + "</div>" +
        controls +
        (isDemo ? '<span class="carousel__badge">Демо</span>' : "") +
      "</div>"
    );
  }

  function initCarousels(scope) {
    scope.querySelectorAll("[data-carousel]").forEach(function (root) {
      var track = root.querySelector("[data-carousel-track]");
      var slideCount = track.children.length;
      var index = 0;

      function goTo(next) {
        index = (next + slideCount) % slideCount;
        var offset = prefersReducedMotion ? -index * 100 : -index * 100;
        track.style.transform = "translateX(" + offset + "%)";
        root.querySelectorAll(".carousel__dot").forEach(function (dot, i) {
          dot.classList.toggle("is-active", i === index);
        });
      }

      var prevBtn = root.querySelector("[data-carousel-prev]");
      var nextBtn = root.querySelector("[data-carousel-next]");
      if (prevBtn) prevBtn.addEventListener("click", function () { goTo(index - 1); });
      if (nextBtn) nextBtn.addEventListener("click", function () { goTo(index + 1); });

      root.querySelectorAll(".carousel__dot").forEach(function (dot) {
        dot.addEventListener("click", function () { goTo(Number(dot.getAttribute("data-index"))); });
      });

      // Touch/pointer swipe
      var startX = null;
      track.addEventListener("pointerdown", function (e) { startX = e.clientX; });
      track.addEventListener("pointerup", function (e) {
        if (startX === null) return;
        var delta = e.clientX - startX;
        startX = null;
        if (Math.abs(delta) < 40) return;
        goTo(delta < 0 ? index + 1 : index - 1);
      });
    });
  }

  function setRentFormFloor(floor) {
    var select = document.querySelector("[data-rent-floor-select]");
    if (select && floor) select.value = String(floor);
  }

  // Заявка из карточки привязывается к помещению и уходит его собственнику.
  var rentListingInput = document.querySelector("[data-rent-listing]");
  var rentListingChip = document.querySelector("[data-rent-listing-chip]");

  function setRentFormListing(listing) {
    setRentFormFloor(listing && listing.floor);
    if (!rentListingInput || !rentListingChip) return;
    rentListingInput.value = listing ? listing.id : "";
    rentListingChip.hidden = !listing;
    if (listing) rentListingChip.querySelector("[data-rent-listing-title]").textContent = listing.title + " · этаж " + listing.floor;
  }

  if (rentListingChip) {
    rentListingChip.querySelector("[data-rent-listing-clear]").addEventListener("click", function () { setRentFormListing(null); });
    var rentFloorSelect = document.querySelector("[data-rent-floor-select]");
    if (rentFloorSelect) {
      rentFloorSelect.addEventListener("change", function () {
        var current = listingsById[rentListingInput.value];
        if (current && String(current.floor) !== rentFloorSelect.value) setRentFormListing(null);
      });
    }
  }

  /* ---------- Listing details modal ---------- */
  var modalOverlay = document.querySelector("[data-modal-overlay]");
  var modalEl = document.querySelector("[data-modal]");
  var modalLastFocused = null;

  function openListingModal(listing, triggerEl) {
    if (!modalOverlay || !modalEl) return;
    modalLastFocused = triggerEl || document.activeElement;

    var price = listing.pricePerM2 && listing.areaM2 ? Math.round(listing.pricePerM2 * listing.areaM2) : null;
    var canApply = listing.status !== "occupied";

    modalEl.querySelector("[data-modal-floor]").textContent = "Этаж " + listing.floor;
    var statusEl = modalEl.querySelector("[data-modal-status]");
    statusEl.textContent = STATUS_LABEL[listing.status];
    statusEl.setAttribute("data-status", listing.status);
    modalEl.querySelector("[data-modal-title]").textContent = listing.title;
    modalEl.querySelector("[data-modal-meta]").innerHTML =
      "<span>" + listing.areaM2 + " м²</span><span>" + escapeHtml(listing.type) + "</span>";
    modalEl.querySelector("[data-modal-desc]").textContent = listing.description;
    modalEl.querySelector("[data-modal-price]").innerHTML = price
      ? price.toLocaleString("ru-RU") + " ₽<small> / мес., пример</small>"
      : "";
    modalEl.querySelector("[data-modal-owner]").textContent = "Собственник: " + listing.owner;

    var actions = modalEl.querySelector("[data-modal-actions]");
    actions.innerHTML = canApply
      ? '<a class="btn btn-primary btn-block" href="#contacts" data-modal-cta>Оставить заявку</a>'
      : "";
    var ctaLink = actions.querySelector("[data-modal-cta]");
    if (ctaLink) {
      ctaLink.addEventListener("click", function () {
        setRentFormListing(listing);
        track("cta", listing.id);
        closeListingModal();
      });
    }

    var mediaEl = modalEl.querySelector("[data-modal-media]");
    mediaEl.innerHTML = renderCarousel(listing);
    initCarousels(mediaEl);

    modalOverlay.classList.add("is-open");
    document.body.style.overflow = "hidden";
    modalEl.querySelector("[data-modal-close]").focus();
  }

  function closeListingModal() {
    if (!modalOverlay) return;
    modalOverlay.classList.remove("is-open");
    document.body.style.overflow = "";
    if (modalLastFocused && typeof modalLastFocused.focus === "function") {
      modalLastFocused.focus();
    }
  }

  if (modalOverlay && modalEl) {
    modalOverlay.addEventListener("click", function (e) {
      if (e.target === modalOverlay) closeListingModal();
    });
    modalEl.querySelector("[data-modal-close]").addEventListener("click", closeListingModal);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && modalOverlay.classList.contains("is-open")) closeListingModal();
    });
    modalEl.addEventListener("keydown", function (e) {
      if (e.key !== "Tab") return;
      var focusable = modalEl.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (!focusable.length) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }

  function populateRentFloorSelect(listings) {
    var select = document.querySelector("[data-rent-floor-select]");
    if (!select) return;
    var floors = Array.from(new Set(listings.map(function (l) { return l.floor; }))).sort(function (a, b) { return a - b; });
    floors.forEach(function (f) {
      var opt = document.createElement("option");
      opt.value = String(f);
      opt.textContent = "Этаж " + f;
      select.appendChild(opt);
    });
  }

  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------- GSAP entrance + scroll reveals ---------- */
  function initReveals() {
    if (!window.gsap) return;
    document.documentElement.classList.add("js-anim-ready");

    if (prefersReducedMotion) {
      document.querySelectorAll("[data-anim]").forEach(function (el) { el.style.opacity = "1"; });
      return;
    }

    gsap.registerPlugin(window.ScrollTrigger);

    // Hero entrance: staged headline lines, then supporting content, then floor stack.
    var heroLines = document.querySelectorAll(".hero-title .line");
    // opacity:1 is forced here (not just yPercent) because the generic
    // ".js-anim-ready [data-anim] { opacity: 0 }" rule in styles.css matches
    // these spans too (they carry data-anim="line", not "fade-up") — without
    // this, the timeline below only ever animates yPercent and the title
    // stays invisible forever.
    gsap.set(heroLines, { yPercent: 110, opacity: 1 });
    var heroTl = gsap.timeline({ defaults: { ease: "power3.out" } });
    heroTl
      .to(".eyebrow", { opacity: 1, y: 0, duration: 0.5 }, 0)
      .to(heroLines, { yPercent: 0, duration: 0.7, stagger: 0.08 }, 0.05)
      .to(".hero-lede", { opacity: 1, y: 0, duration: 0.5 }, 0.35)
      .to(".hero-actions", { opacity: 1, y: 0, duration: 0.5 }, 0.42)
      .to(".hero-stats", { opacity: 1, y: 0, duration: 0.5 }, 0.48)
      .fromTo(".floor-row", { opacity: 0, x: 16 }, { opacity: 1, x: 0, duration: 0.4, stagger: 0.04 }, 0.25);

    gsap.set([".eyebrow", ".hero-lede", ".hero-actions", ".hero-stats"], { y: 12 });

    // Section eyebrows + headings: the SAME line-reveal motif as the hero
    // title above, just scroll-triggered instead of firing on load. One
    // signature motion reused deliberately, rather than a second/third
    // generic scroll-fade recipe invented for headings specifically.
    var revealLines = document.querySelectorAll("main :not(.hero) [data-anim='reveal-line']");
    revealLines.forEach(function (el) {
      gsap.set(el, { yPercent: 100, opacity: 1 });
      gsap.to(el, {
        yPercent: 0,
        duration: 0.6,
        ease: "power3.out",
        scrollTrigger: { trigger: el, start: "top 88%", once: true }
      });
    });

    // Supporting content (lede paragraphs, lists, map) below the hero:
    // появляется секцией целиком, а не каждый абзац на своём отдельном
    // триггере — та самая «AOS fade-up» лесенка вниз по странице, которой
    // здесь сознательно избегаем.
    //
    // Раньше это делал ScrollTrigger.batch, и на iPhone он не срабатывал:
    // разделы «Собственникам» и «Контакты» оставались пустыми. Причина в
    // асимметрии — reveal-line выше сразу ставит opacity: 1 инлайном, поэтому
    // заголовки видны в любом случае, а fade-up получал только { y: 10 } и
    // оставался под правилом ".js-anim-ready [data-anim] { opacity: 0 }" из
    // styles.css до тех пор, пока не сработает onEnter. Не сработал — текст
    // не показался никогда.
    //
    // Теперь проявлением управляет свой обработчик прокрутки: он не может
    // «пропустить» элемент — на каждом кадре он просто показывает всё, что
    // уже поднялось выше нижней кромки экрана.
    // Карточки объявлений исключены: они создаются заново при каждой смене
    // фильтра и проявляются своей анимацией в renderListingGrid.
    var fadeSel = "main :not(.hero) [data-anim='fade-up']:not(.listing-card)";
    gsap.set(fadeSel, { y: 10 });
    revealOnScroll(document.querySelectorAll(fadeSel));

    // Subtle ambient drift on hero background (transform only, cheap on any device).
    gsap.to(".hero-bg", {
      backgroundPosition: "20px -20px",
      duration: 18,
      ease: "sine.inOut",
      repeat: -1,
      yoyo: true
    });
  }

  /* Проявление блоков при прокрутке.
     Намеренно без ScrollTrigger и без IntersectionObserver: элемент
     показывается, как только его верх оказался выше нижней кромки экрана, и
     проверка повторяется на каждой прокрутке и смене размера. Даже если
     какое-то событие потеряется, следующая же прокрутка всё исправит —
     скрытым контент не останется. */
  function revealOnScroll(nodes) {
    var pending = Array.prototype.slice.call(nodes);
    if (!pending.length) return;
    var scheduled = false;

    function show(el, index) {
      if (window.gsap && !prefersReducedMotion) {
        gsap.to(el, { opacity: 1, y: 0, duration: 0.4, delay: index * 0.04, ease: "power2.out" });
      } else {
        el.style.opacity = "1";
        el.style.transform = "none";
      }
    }

    function flush() {
      scheduled = false;
      var doc = document.documentElement;
      var vh = window.innerHeight || doc.clientHeight;
      // Последние элементы страницы могут физически не подняться выше порога
      // 0.92 — прокручивать дальше уже некуда. Поэтому у самого низа
      // показываем всё, что осталось, иначе они застряли бы невидимыми
      // (так пропадала карта в «Контактах»).
      var atBottom = window.pageYOffset + vh >= doc.scrollHeight - 4;
      var shown = 0;
      pending = pending.filter(function (el) {
        // 0.92 — показываем чуть раньше, чем элемент упрётся в нижний край,
        // иначе движение начинается уже под обрезом экрана и его не видно.
        if (!atBottom && el.getBoundingClientRect().top > vh * 0.92) return true;
        show(el, shown++);
        return false;
      });
      if (!pending.length) {
        window.removeEventListener("scroll", onScroll);
        window.removeEventListener("resize", onScroll);
      }
    }

    function onScroll() {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(flush);
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    flush(); // то, что уже на экране, показываем сразу
  }

  /* ---------- Forms: заявки уходят в API, оттуда — собственнику и администратору ---------- */
  document.querySelectorAll("[data-form]").forEach(function (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var statusEl = form.querySelector("[data-form-status]");
      var submitBtn = form.querySelector('button[type="submit"]');
      var kind = form.getAttribute("data-form");
      var payload = { kind: kind };
      new FormData(form).forEach(function (value, key) { payload[key] = value; });
      payload.consent = Boolean(form.querySelector('[name="consent"]:checked'));

      if (!payload.consent) {
        setStatus(statusEl, "Отметьте согласие на обработку персональных данных — без него заявку отправить нельзя.", "error");
        return;
      }

      if (submitBtn) submitBtn.disabled = true;
      setStatus(statusEl, "Отправляем…", null);

      fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (data) {
            if (!res.ok) {
              var err = new Error(data.message || "bad status " + res.status);
              err.fromServer = Boolean(data.message) && res.status < 500;
              throw err;
            }
          });
        })
        .then(function () {
          setStatus(statusEl, "Заявка отправлена — мы свяжемся с вами.", "success");
          form.reset();
          if (form.id === "rent-form") setRentFormListing(null);
        })
        .catch(function (err) {
          setStatus(statusEl, err.fromServer ? err.message : "Не получилось отправить форму. Напишите нам в Telegram или по телефону — контакты в разделе «Контакты».", "error");
        })
        .finally(function () {
          if (submitBtn) submitBtn.disabled = false;
        });
    });
  });

  function setStatus(el, text, state) {
    if (!el) return;
    el.textContent = text;
    if (state) el.setAttribute("data-state", state);
    else el.removeAttribute("data-state");
  }

  /* ---------- Статистика для кабинетов ----------
     Считаем просмотры страницы, показы и открытия карточек, клики «Оставить
     заявку» и по контактам. Без cookie и персональных данных: только
     случайный id браузера в localStorage, на сервере он хранится хешем. */
  function track(type, listingCode) {
    statsQueue.push(listingCode ? { t: type, l: listingCode } : { t: type });
    if (statsQueue.length >= 20) flushStats();
  }

  function visitorId() {
    try {
      var id = localStorage.getItem("dbVisitor");
      if (!id) {
        id = Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem("dbVisitor", id);
      }
      return id;
    } catch (e) {
      return "";
    }
  }

  function flushStats() {
    if (!statsQueue.length) return;
    var body = JSON.stringify({ v: visitorId(), events: statsQueue.splice(0, 100) });
    try {
      fetch("/api/stats", { method: "POST", headers: { "Content-Type": "application/json" }, body: body, keepalive: true }).catch(function () {});
    } catch (e) { /* статистика не важнее страницы */ }
  }

  // Карточка «показана», если хотя бы наполовину побыла в экране; каждая — один раз за визит.
  var seenCards = {};
  var impressionObserver = "IntersectionObserver" in window
    ? new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var code = entry.target.getAttribute("data-listing-code");
          impressionObserver.unobserve(entry.target);
          if (code && !seenCards[code]) {
            seenCards[code] = true;
            track("impression", code);
          }
        });
      }, { threshold: 0.5 })
    : null;

  function observeImpressions(grid) {
    if (!impressionObserver) return;
    grid.querySelectorAll("[data-listing-details]").forEach(function (btn) {
      var card = btn.closest(".listing-card");
      if (!card) return;
      card.setAttribute("data-listing-code", btn.getAttribute("data-listing-details"));
      impressionObserver.observe(card);
    });
  }

  document.addEventListener("click", function (e) {
    var link = e.target.closest && e.target.closest('a[href^="tel:"], a[href^="mailto:"], a[href*="t.me/"], a[data-max-link]');
    if (link) track("contact");
  });

  track("view");
  setInterval(flushStats, 5000);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flushStats();
  });
  window.addEventListener("pagehide", flushStats);

  /* ---------- Вход: если уже в кабинете, ссылка ведёт туда ---------- */
  fetchJson("/api/auth/me").then(function (me) {
    if (!me.user) return;
    document.querySelectorAll("[data-account-link]").forEach(function (a) {
      a.textContent = "Кабинет";
      a.href = me.user.role === "admin" ? "/admin/" : "/cabinet/";
    });
  }).catch(function () {});

  /* ---------- Яндекс Метрика: номер счётчика — в админке, загрузка — после согласия ---------- */
  var cookieBanner = document.querySelector("[data-cookie-banner]");

  function cookieChoice(value) {
    try {
      if (value) localStorage.setItem("dbCookie", value);
      return localStorage.getItem("dbCookie");
    } catch (e) {
      return value || null;
    }
  }

  function loadMetrika(id) {
    window.ym = window.ym || function () { (window.ym.a = window.ym.a || []).push(arguments); };
    window.ym.l = Date.now();
    var script = document.createElement("script");
    script.async = true;
    script.src = "https://mc.yandex.ru/metrika/tag.js";
    document.head.appendChild(script);
    window.ym(Number(id), "init", { clickmap: true, trackLinks: true, accurateTrackBounce: true });
  }

  fetchJson("/api/settings").then(function (settings) {
    if (!settings.metrikaId || !cookieBanner) return;
    var choice = cookieChoice();
    if (choice === "all") return loadMetrika(settings.metrikaId);
    if (choice === "necessary") return;
    cookieBanner.hidden = false;
    cookieBanner.querySelector("[data-cookie-accept]").addEventListener("click", function () {
      cookieChoice("all");
      cookieBanner.hidden = true;
      loadMetrika(settings.metrikaId);
    });
    cookieBanner.querySelector("[data-cookie-decline]").addEventListener("click", function () {
      cookieChoice("necessary");
      cookieBanner.hidden = true;
    });
  }).catch(function () {});
})();
