-- Этап 1: пользователи, вход, объявления, заявки, статистика, журнал.

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id            bigserial PRIMARY KEY,
  email         citext UNIQUE,
  name          text NOT NULL DEFAULT '',
  phone         text NOT NULL DEFAULT '',
  company       text NOT NULL DEFAULT '',
  -- admin — владелец сайта; landlord — собственник помещений; tenant — арендатор.
  role          text NOT NULL DEFAULT 'tenant' CHECK (role IN ('admin', 'landlord', 'tenant')),
  -- Собственник до подтверждения админом — pending: может войти и готовить черновики,
  -- но не отправлять их на модерацию.
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'blocked')),
  password_hash text,
  notify        jsonb NOT NULL DEFAULT '{"email": true, "telegram": true}',
  consent_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

-- Внешние входы: Telegram, Яндекс ID, VK ID.
CREATE TABLE identities (
  id           bigserial PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider     text NOT NULL CHECK (provider IN ('telegram', 'yandex', 'vk')),
  provider_uid text NOT NULL,
  profile      jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_uid)
);
CREATE INDEX identities_user_idx ON identities (user_id);

-- В cookie лежит случайный токен, в базе — только его sha256.
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ip         text NOT NULL DEFAULT '',
  user_agent text NOT NULL DEFAULT ''
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE email_codes (
  email      citext PRIMARY KEY,
  code_hash  text NOT NULL,
  attempts   int NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE uploads (
  id         uuid PRIMARY KEY,
  user_id    bigint REFERENCES users(id) ON DELETE SET NULL,
  path       text NOT NULL,
  thumb_path text NOT NULL,
  width      int NOT NULL,
  height     int NOT NULL,
  bytes      int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE listings (
  id                 bigserial PRIMARY KEY,
  code               text UNIQUE NOT NULL,
  owner_id           bigint REFERENCES users(id) ON DELETE SET NULL,
  -- Подпись на карточке («Собственник этажа 1»), не обязательно имя пользователя.
  owner_label        text NOT NULL DEFAULT '',
  floor              int NOT NULL CHECK (floor BETWEEN 1 AND 8),
  title              text NOT NULL,
  type               text NOT NULL DEFAULT '',
  area_m2            numeric(8, 1) NOT NULL CHECK (area_m2 > 0),
  price_per_m2       int NOT NULL CHECK (price_per_m2 >= 0),
  description        text NOT NULL DEFAULT '',
  -- Занятость меняется собственником сразу, без модерации.
  availability       text NOT NULL DEFAULT 'available'
                       CHECK (availability IN ('available', 'reserved', 'occupied')),
  floor_plan         text NOT NULL DEFAULT '',
  photos             jsonb NOT NULL DEFAULT '[]',
  demo               boolean NOT NULL DEFAULT false,
  moderation         text NOT NULL DEFAULT 'draft'
                       CHECK (moderation IN ('draft', 'pending', 'published', 'rejected', 'archived')),
  moderation_comment text NOT NULL DEFAULT '',
  -- Правки уже опубликованного объявления ждут модерации здесь, живая версия не меняется.
  pending_changes    jsonb,
  sort               int NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  submitted_at       timestamptz,
  published_at       timestamptz
);
CREATE INDEX listings_owner_idx ON listings (owner_id);
CREATE INDEX listings_moderation_idx ON listings (moderation);

CREATE TABLE leads (
  id          bigserial PRIMARY KEY,
  -- listing — заявка на помещение; owner — «Сдаёте площадь?»; contact — общая форма.
  kind        text NOT NULL CHECK (kind IN ('listing', 'owner', 'contact')),
  listing_id  bigint REFERENCES listings(id) ON DELETE SET NULL,
  landlord_id bigint REFERENCES users(id) ON DELETE SET NULL,
  user_id     bigint REFERENCES users(id) ON DELETE SET NULL,
  name        text NOT NULL DEFAULT '',
  phone       text NOT NULL DEFAULT '',
  email       text NOT NULL DEFAULT '',
  message     text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'new'
                CHECK (status IN ('new', 'in_progress', 'viewing', 'won', 'lost', 'spam')),
  note        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_landlord_idx ON leads (landlord_id, created_at DESC);
CREATE INDEX leads_user_idx ON leads (user_id);

CREATE TABLE lead_events (
  id         bigserial PRIMARY KEY,
  lead_id    bigint NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id    bigint REFERENCES users(id) ON DELETE SET NULL,
  from_status text,
  to_status  text NOT NULL,
  comment    text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Счётчики по дням. listing_id = 0 — события сайта целиком.
CREATE TABLE stats_daily (
  day        date NOT NULL,
  listing_id bigint NOT NULL DEFAULT 0,
  metric     text NOT NULL,
  count      int NOT NULL DEFAULT 0,
  PRIMARY KEY (day, listing_id, metric)
);

-- Уникальные посетители: случайный id из браузера, хешированный с солью дня.
CREATE TABLE stats_visitors (
  day          date NOT NULL,
  visitor_hash text NOT NULL,
  PRIMARY KEY (day, visitor_hash)
);

CREATE TABLE settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  user_id    bigint REFERENCES users(id) ON DELETE SET NULL,
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  text NOT NULL DEFAULT '',
  meta       jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
