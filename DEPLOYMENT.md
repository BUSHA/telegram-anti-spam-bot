# Telegram Anti-Spam Bot: Гайд з налаштування та розгортання

Цей гайд описує процес першого налаштування та розгортання антиспам-бота для Telegram на базі Cloudflare Workers + D1.

## 1. Попередні вимоги

- Акаунт Cloudflare з увімкненими Workers + D1 (достатньо безкоштовного плану)
- Встановлені Node.js 18+ та npm
- Токен Telegram-бота від `@BotFather`
- Група в Telegram, куди додано бота
- Бот має права адміністратора в групі:
  - Видалення повідомлень (Delete messages)
  - Бан користувачів (Ban users)
  - Читання повідомлень (Read group messages)

## 2. Інсталяція проекту

З кореневої директорії проекту:

```bash
npm install
npm run types
```

`npm run types` генерує файл `worker-configuration.d.ts` (необхідний для коректної роботи TypeScript та IDE).

## 3. Авторизація в Cloudflare

Авторизуйте Wrangler:

```bash
npx wrangler login
```

Перевірте авторизацію:

```bash
npx wrangler whoami
```

## 4. Створення бази даних D1

Створіть базу:

```bash
npx wrangler d1 create telegram_antispam
```

Скопіюйте отриманий `database_id` та вставте його у файл [wrangler.toml](wrangler.toml):

```toml
[[d1_databases]]
binding = "DB"
database_name = "telegram_antispam"
database_id = "ВСТАВТЕ_ВАШ_DATABASE_ID_ТУТ"
```

## 5. Запуск першої міграції

```bash
npx wrangler d1 migrations apply telegram_antispam --remote
```


## 6. Створення черги (Queue)

Створіть чергу, необхідну для роботи системи премодерації:

```bash
npx wrangler queues create anti-spam-delay-queue
```

## 7. Деплой воркера

Розгорніть проект:

```bash
npx wrangler deploy
```

Після деплою запишіть URL вашого воркера, наприклад:

`https://telegram-anti-spam-bot.<subdomain>.workers.dev`

Бот використовуватиме цю адресу для налаштування вебхука Telegram.

## 8. Налаштування Telegram-бота та групи

### 8.1 Отримання токена бота

У Telegram напишіть `@BotFather`:

1. `/newbot`
2. Вкажіть ім'я та юзернейм
3. Скопіюйте токен (формату `123456:ABC...`)

### 8.2 Додавання бота в групу

Додайте бота до цільової групи та надайте йому права адміністратора:

- Видалення повідомлень
- Бан користувачів

### 8.3 Отримання ID чату

Використовуйте один із методів:

- Бот `@RawDataBot` (додайте його в групу)
- Метод `getUpdates` у Telegram API

Для супергруп Chat ID зазвичай починається з `-100...` (наприклад, `-1001234567890`).

## 9. Системне налаштування в адмін-панелі

Відкрийте у браузері:

- `https://<ваша-адреса-воркера>/admin`

У розділі **System Setup** (Системні налаштування) введіть:

- Bot Token
- Target Chat ID

Натисніть **Save & Set Webhook**.

Це виконає такі дії:

1. Збереже налаштування в D1 (`TELEGRAM_TOKEN`, `CHAT_ID`, `WORKER_URL`)
2. Створить та захешує `WEBHOOK_SECRET`
3. Викличе метод Telegram `setWebhook` для підключення бота до вашого воркера з валідацією токена.

## 10. Захист `/admin` через Cloudflare Zero Trust

Цей проект свідомо не має вбудованої системи логіну. Захистіть шлях `/admin/*` за допомогою Cloudflare Access.

1. Cloudflare Dashboard -> Zero Trust -> Access -> Applications -> Add application
2. Тип: **Self-hosted**
3. Домен: адреса вашого воркера
4. Path (шлях): `/admin/*`
5. Додайте політику (Policy):
   - Action: Allow
   - Include: ваш email або група провайдера ідентифікації
6. Збережіть та протестуйте доступ.

Рекомендовано:

- Шлях `/webhook` залиште публічним
- Захистіть лише `/admin` та `/admin/api/*`

## 11. Перевірка розгортання

### 11.1 Перевірка працездатності (Health check)

```bash
curl https://<ваша-адреса-воркера>/health
```

Очікувана відповідь:

```json
{"ok":true}
```

### 11.2 Перевірка вебхука

```bash
curl "https://api.telegram.org/bot<ВАШ_ТОКЕН>/getWebhookInfo"
```

Перевірте:

- `url` має бути `https://<ваша-адреса-воркера>/webhook`
- Відсутність помилок у полі `last_error_message`

### 11.3 Тестування функціоналу

1. Додайте тестове слово у чорний список (Blacklist) в `/admin`.
2. Надішліть це слово в групу з акаунта, який **не є адміном**.
3. Очікуваний результат: повідомлення видалено + користувача забанено + запис з'явився в історії (History).

## 12. Короткий опис роботи системи

- Адміністратори чату ігноруються (список кешується через `getChatAdministrators`).
- Нормалізація тексту перед перевіркою:
  - Перетворення в нижній регістр
  - Заміна латинських гомогліфів на кириличні
  - Видалення невидимих Unicode-символів
- Жорсткий збіг (Hard match):
  - Видалення повідомлення
  - Бан користувача
  - Запис в аудит-лог
- М'який збіг (Soft match):
  - Повідомлення потрапляє в карантин
  - Ручна перевірка модератором через адмін-панель

## 13. Обслуговування

Оновлюйте типи після змін у `wrangler.toml`:

```bash
npm run types
```

Передеплой після змін у коді:

```bash
npx wrangler deploy
```

За потреби можна переглянути дані D1 через консоль:

```bash
npx wrangler d1 execute telegram_antispam --remote --command "SELECT * FROM logs ORDER BY id DESC LIMIT 20;"
```

## 14. Вирішення проблем

- `Cannot find name 'D1Database'`:
  - Запустіть `npm run types`
  - Перезапустіть TypeScript сервер в IDE
- Вебхук не працює:
  - Перевірте `getWebhookInfo`
  - Переконайтеся, що `/webhook` НЕ закритий політикою Zero Trust
- Повідомлення не видаляються:
  - Перевірте права бота в групі (адмін з правом видалення)
  - Перевірте, чи не є відправник адміністратором чату

## 15. Нотатки з безпеки

- Ніколи не зберігайте токен бота у відкритому коді
- У разі витоку токена — відкличте його у `@BotFather` та оновіть в налаштуваннях панелі
- Обмежуйте доступ до `/admin/*` лише для довірених осіб

---

# Telegram Anti-Spam Bot: Setup and Deployment Guide (English)

This guide covers first-time setup and production deployment for the Cloudflare Workers + D1 Telegram anti-spam bot.

## 1. Prerequisites

- Cloudflare account with Workers + D1 enabled (free tier is sufficient)
- Node.js 18+ and npm installed
- A Telegram bot token from `@BotFather`
- Target Telegram group where the bot is already added
- Bot has admin permissions in that group:
  - Delete messages
  - Ban users
  - Read group messages

## 2. Project Install

From the project root:

```bash
npm install
npm run types
```

`npm run types` generates `worker-configuration.d.ts` (required for IDE/runtime types).

## 3. Cloudflare Auth

Authenticate Wrangler:

```bash
npx wrangler login
```

Verify:

```bash
npx wrangler whoami
```

## 4. Create D1 Database

Create DB:

```bash
npx wrangler d1 create telegram_antispam
```

Copy the returned `database_id` and put it into [wrangler.toml](wrangler.toml):

```toml
[[d1_databases]]
binding = "DB"
database_name = "telegram_antispam"
database_id = "PASTE_REAL_DATABASE_ID_HERE"
```

## 5. Run First Migration

```bash
npx wrangler d1 migrations telegram_antispam --remote
```

## 6. Create Delay Queue

Create the queue required for pre-moderation processing:

```bash
npx wrangler queues create anti-spam-delay-queue
```

## 7. Deploy Worker

Deploy:

```bash
npx wrangler deploy
```

After deploy, note your Worker URL, for example:

`https://telegram-anti-spam-bot.<subdomain>.workers.dev`

The bot uses this URL for Telegram webhook setup.

## 8. Telegram Bot and Group Setup

... (Refer to Ukrainian section for full steps or the original doc)
