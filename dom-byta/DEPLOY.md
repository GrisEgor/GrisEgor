# Дом быта — запуск на сервере

Сайт, админка и кабинеты — одно приложение в Docker: Node.js + PostgreSQL, перед ними Caddy
с автоматическим HTTPS. Всё ставится на один VPS за ~30 минут.

## 0. Проверить у себя (необязательно)

Нужен Docker Desktop.

```bash
cd dom-byta
docker compose up --build
```

Сайт — http://localhost:8080, вход — http://localhost:8080/login/. Администратором станет
`admin@example.com` (или адрес из `ADMIN_EMAIL` в `.env`). Письма локально не отправляются:
код входа виден по ссылке «Посмотреть код» на странице входа (http://localhost:8080/api/dev/outbox).

Тесты: `cd server && npm install && npm test` (при запущенном `docker compose up`).

## 1. Сервер

- **VPS в России** (152-ФЗ: данные граждан РФ хранятся в РФ). Подойдёт любой: Timeweb Cloud,
  Selectel, Yandex Cloud, REG.RU. Хватит 1 vCPU, 2 ГБ RAM, 20 ГБ диска, Ubuntu 24.04.
  Для скорости из Челябинска — дата-центр в Екатеринбурге или Москве.
- **Домен**: в DNS добавьте запись `A` для домена (и для `www`) на IP сервера. Подождите, пока
  `ping ваш-домен` не покажет этот IP.

## 2. Установка

Подключитесь к серверу (`ssh root@IP`) и выполните:

```bash
curl -fsSL https://get.docker.com | sh
git clone https://github.com/GrisEgor/GrisEgor.git /opt/grisegor
cd /opt/grisegor/dom-byta
cp .env.example .env
nano .env
```

В `.env` обязательно заполните `DOMAIN`, `DB_PASSWORD` (длинная случайная строка —
например, из `openssl rand -hex 24`), `ADMIN_EMAIL` и почту `SMTP_*` (шаг 3). Остальное можно позже.

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

Через минуту сайт откроется на `https://ваш-домен` — сертификат Caddy получит сам.
При первом запуске в базу переносятся объявления из `site/data/listings.json`.

Войдите на `https://ваш-домен/login/` с адресом из `ADMIN_EMAIL` — аккаунт станет администратором.

## 3. Почта (коды входа и уведомления)

Без почты вход по коду не работает. Варианты:

- **Яндекс 360 для бизнеса** на своём домене: создайте ящик `noreply@домен`, включите пароль
  приложения («Безопасность → Пароли приложений → Почта»). `SMTP_HOST=smtp.yandex.ru`,
  `SMTP_PORT=465`, `SMTP_USER=noreply@домен`, `SMTP_PASS=пароль приложения`.
- **Mail.ru для бизнеса**: `smtp.mail.ru`, порт 465.
- **Unisender Go / SendPulse** — если писем будет много.

`MAIL_FROM` должен совпадать с ящиком. Чтобы письма не попадали в спам, добавьте в DNS записи
SPF и DKIM, которые покажет почтовый сервис.

После правки `.env`: `docker compose -f docker-compose.prod.yml up -d` (пересборка не нужна).

## 4. Вход через Telegram, Яндекс ID, VK ID

Каждый способ включается, когда заполнены его переменные в `.env`; кнопки появятся сами.

**Telegram** (заодно уведомления о заявках в Telegram):
1. В Telegram откройте @BotFather → `/newbot`, задайте имя (например, «Дом быта Васенко 96»).
2. Скопируйте токен в `TELEGRAM_BOT_TOKEN`, имя бота без `@` — в `TELEGRAM_BOT_USERNAME`.
3. В @BotFather: `/setdomain` → выберите бота → введите ваш домен.

**Яндекс ID**:
1. https://oauth.yandex.ru → «Создать приложение» → «Веб-сервисы».
2. Redirect URI: `https://ваш-домен/api/auth/yandex/callback`.
3. Доступы: «Доступ к адресу электронной почты», «Доступ к логину, имени и фамилии».
4. ClientID и Client secret — в `YANDEX_CLIENT_ID` и `YANDEX_CLIENT_SECRET`.

**VK ID**:
1. https://id.vk.com/about/business → «Создать приложение» → «Веб-сайт».
2. Базовый домен — ваш домен, доверенный Redirect URL: `https://ваш-домен/api/auth/vk/callback`.
3. Доступ к почте — включить. ID приложения — в `VK_CLIENT_ID` (секрет не нужен).

## 5. Яндекс Метрика

Создайте счётчик на https://metrika.yandex.ru (адрес — ваш домен), номер вставьте в админке:
«Настройки → Яндекс Метрика». Посетители увидят баннер о cookie; Метрика загружается только после
их согласия. Своя статистика по объявлениям в админке работает и без Метрики.

## 6. Резервные копии

```bash
sh deploy/backup.sh            # база + фото в /var/backups/dombyta, хранятся 14 последних
crontab -e                     # каждую ночь в 3:30:
30 3 * * * cd /opt/grisegor/dom-byta && sh deploy/backup.sh >> /var/log/dombyta-backup.log 2>&1
```

Копии стоит периодически забирать с сервера (например, в Яндекс Диск). Восстановление:
`sh deploy/restore.sh /var/backups/dombyta/db_ДАТА.sql.gz /var/backups/dombyta/uploads_ДАТА.tar.gz`.

## 7. Обновление

```bash
cd /opt/grisegor/dom-byta
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

Миграции базы применяются автоматически при запуске.

Логи: `docker compose -f docker-compose.prod.yml logs -f app`.

## 8. 152-ФЗ — что сделать владельцу

- [ ] Подать уведомление в Роскомнадзор об обработке персональных данных (pd.rkn.gov.ru).
- [ ] Заполнить в `site/privacy/index.html` всё, что выделено `[в скобках]`: оператор, ИНН,
      адрес, почта для обращений, номер в реестре, сроки хранения. Затем обновить сайт (шаг 7).
- [ ] Согласие в формах и баннер о cookie уже есть на сайте — ничего делать не нужно.
- [ ] Сервер — в России (шаг 1).
