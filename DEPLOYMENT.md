# Telegram Anti-Spam Bot: Гайд з налаштування та розгортання

Цей гайд описує процес першого налаштування та розгортання антиспам-бота для Telegram на базі Cloudflare Workers + D1.

## 1. Попередні вимоги

- Акаунт Cloudflare з увімкненими Workers + D1 (достатньо безкоштовного плану)
- Встановлені Node.js 18+ та npm
- Токен Telegram-бота від `@BotFather`
- Одна або кілька груп/супергруп Telegram, куди додано бота
- Бот має права адміністратора в кожному чаті, який він модеруватиме:
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

### Рекомендований спосіб (через Wrangler):

```bash
npx wrangler d1 execute telegram_antispam --remote --file=schema.sql
```

### Альтернативний спосіб (через Cloudflare API та curl):

```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/d1/database/<DATABASE_ID>/query" \
  -H "Authorization: Bearer <CF_API_TOKEN>" \
  -H "Content-Type: application/json" \
  --data-binary @<(jq -n --arg sql "$(cat schema.sql)" '{sql: [$sql]}')
```

## 6. Створення черги (Queue)

Створіть чергу, необхідну для роботи системи премодерації:

```bash
npx wrangler queues create anti-spam-delay-queue
```

## 7. Деплой воркера

Розгорніть проект:

```bash
npx tsc --noEmit
npx wrangler deploy --dry-run
npx wrangler deploy
```

Після деплою запишіть URL вашого воркера, наприклад:

`https://telegram-anti-spam-bot.<subdomain>.workers.dev`

Бот використовуватиме цю адресу для налаштування вебхука Telegram.

## 8. Налаштування Telegram-бота та груп

### 8.1 Отримання токена бота

У Telegram напишіть `@BotFather`:

1. `/newbot`
2. Вкажіть ім'я та юзернейм
3. Скопіюйте токен (формату `123456:ABC...`)

### 8.2 Додавання бота в групи

Додайте бота до кожної цільової групи/супергрупи та надайте йому права адміністратора:

- Видалення повідомлень
- Бан користувачів

### 8.3 Отримання ID чату

Рекомендований спосіб — використати самого бота:

1. Задеплойте воркер.
2. Додайте бота в потрібні групи.
3. Напишіть боту в приват:

```text
/chats
```

Бот покаже список не приватних чатів, які він бачив, разом з їх ID. Якщо чат не з'явився, видаліть і повторно додайте бота або надішліть повідомлення в цьому чаті, яке бот може отримати.

Альтернативні способи:

- Бот `@RawDataBot` (додайте його в групу)
- Метод `getUpdates` у Telegram API

Для супергруп Chat ID зазвичай починається з `-100...` (наприклад, `-1001234567890`).

## 9. Системне налаштування в адмін-панелі

Відкрийте у браузері:

- `https://<ваша-адреса-воркера>/admin`

У розділі **Налаштування системи** введіть:

- токен бота;
- один або кілька рядків призначень:
  - `ID чату`
  - `ID адміністратора / адміністраторів`

В одному рядку можна вказати один ID чату та одного або кількох адміністраторів через кому. Наприклад:

```text
ID чату: -1001234567890
ID адміністратора / адміністраторів: 123456789, 987654321
```

Натисніть **Зберегти та встановити вебхук**.

Це виконає такі дії:

1. Збереже токен бота, URL воркера, список чатів, адміністраторів та їх призначення в D1.
2. Створить `WEBHOOK_SECRET`, якщо він ще не існує.
3. Викличе метод Telegram `setWebhook` для підключення бота до вашого воркера з валідацією токена.
4. Спробує отримати назви чатів через Telegram `getChat` та імена адміністраторів через `getChatMember`.

Токен бота не показується після збереження. Щоб залишити поточний токен, залиште поле токена порожнім.

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
npx tsc --noEmit
npx wrangler deploy --dry-run
npx wrangler deploy
```

### Безпечний деплой існуючого production-воркера

Перед змінами, що зачіпають D1-схему або поведінку модерації:

1. Перевірте, що працюєте з правильною базою:

```bash
npx wrangler d1 info telegram_antispam
```

2. Збережіть timestamp для можливого Time Travel rollback:

```bash
date -u +"%Y-%m-%dT%H:%M:%SZ"
```

3. Перевірте, що Time Travel може знайти стан за цим timestamp:

```bash
npx wrangler d1 time-travel info telegram_antispam --timestamp "PASTE_TIMESTAMP_HERE"
```

4. Зробіть SQL export як додаткову копію:

```bash
mkdir -p backups
npx wrangler d1 export telegram_antispam --remote --output backups/telegram_antispam_before_deploy.sql
```

5. Перевірте код і виконайте dry run:

```bash
npx tsc --noEmit
npx wrangler deploy --dry-run
```

6. Задеплойте:

```bash
npx wrangler deploy
```

7. Викличте health check, щоб воркер виконав `ensureSchema()`:

```bash
curl https://<ваша-адреса-воркера>/health
```

8. Перевірте ключові таблиці:

```bash
npx wrangler d1 execute telegram_antispam --remote --command "SELECT chat_id, title FROM bot_chats;"
npx wrangler d1 execute telegram_antispam --remote --command "SELECT admin_user_id, chat_id FROM admin_chat_assignments;"
npx wrangler d1 execute telegram_antispam --remote --command "SELECT value FROM settings WHERE key='QUARANTINE_CHAT_UNIQUE_MIGRATED';"
```

Якщо потрібен rollback D1:

```bash
npx wrangler d1 time-travel restore telegram_antispam --timestamp "PASTE_TIMESTAMP_HERE"
```

Ця команда перезаписує remote D1 стан, тому використовуйте її лише якщо проблема саме в даних/міграції.

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
- Токен у панелі керування є write-only: API не повертає збережене значення токена
- У разі витоку токена — відкличте його у `@BotFather` та оновіть в налаштуваннях панелі
- Обмежуйте доступ до `/admin/*` лише для довірених осіб

---

# Telegram Anti-Spam Bot: Setup and Deployment Guide (English Summary)

The Ukrainian section above is the source of truth for operations. In short:

- Create D1 and Queue with Wrangler.
- Apply `schema.sql` for first setup.
- Deploy with:

```bash
npx tsc --noEmit
npx wrangler deploy --dry-run
npx wrangler deploy
```

- Configure the bot in `/admin`.
- Add one or more assignment rows: chat ID plus one or more admin IDs.
- Leave the token field empty when saving if you do not want to rotate the stored token.
- To discover group/supergroup IDs, add the bot to chats and send `/chats` to the bot privately.
- Protect `/admin/*` with Cloudflare Access.
- For existing production deployments, export D1 and record a Time Travel timestamp before deploy.
