# Telegram Anti-Spam Bot (Cloudflare Workers + D1 + Queues)

Цей проект — антиспам-бот для Telegram, що працює на Cloudflare Workers, використовує D1 для бази даних та Queues для надійної обробки капчі. Бот підтримує кілька чатів і гнучке призначення адміністраторів.

![Dashboard Screenshot](Screenshot.png)

## Основні можливості

- **Розумна нормалізація тексту**: Ефективна боротьба зі спамом, що використовує гомогліфи (схожі за виглядом латинські літери замість кириличних), приховані Unicode-символи та інші методи обходу фільтрів.
- **Дворівнева фільтрація (Anti-Spam)**:
  - **Чорний список (Hard match)**: Негайне видалення повідомлення та постійний бан користувача.
  - **Карантин (Soft match)**: Повідомлення з підозрілими словами або посиланнями автоматично потрапляють у чергу на перевірку модератором у зручній адмін-панелі.
- **Система Премодерації (Капча)**: 
  - Нові користувачі повинні підтвердити, що вони не боти, розв'язавши просту задачу (вибір цифри, написаної словом).
  - Надійне керування таймаутами через Cloudflare Queues (навіть якщо воркер перезапуститься, капча буде оброблена).
  - Тимчасове обмеження прав користувача (read-only) до проходження перевірки.
- **Безпечний режим (Safe Mode)**: Можливість тестувати фільтри в "сухому" режимі — повідомлення не видаляються, а користувачі не баняться (система лише записує, що б вона зробила).
- **Підтримка кількох чатів**:
  - Один бот може працювати в кількох групах/супергрупах.
  - Один адміністратор може бути призначений до кількох чатів.
  - Кілька адміністраторів можуть бути призначені до одного або кількох чатів.
  - У логах, історії, карантині та звітах показується назва чату.
  - Telegram-сповіщення містять назву чату лише тоді, коли конкретний адміністратор має більше одного призначеного чату.
- **Пошук ID чатів**: Адміністратор може написати боту в приват `/chats`, щоб отримати список не приватних чатів, які бот бачив після додавання або отримання повідомлення.
- **Зручна Адмін-панель**: 
  - Перегляд історії дій у реальному часі.
  - Керування чорним списком та стоп-словами.
  - Модерація карантину (схвалення або видалення повідомлень).
  - Гнучкі налаштування капчі та системних параметрів.
- **Безпечне зберігання токена**: Токен Telegram-бота не показується в UI після збереження. Поле токена в адмін-панелі є write-only: залиште його порожнім, щоб не змінювати збережене значення.
- **Локалізація**: Повна підтримка української мови для повідомлень у чаті та інтерфейсу керування.

## Технологічний стек

- **Core**: [Hono](https://hono.dev/) на Cloudflare Workers.
- **Database**: [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite).
- **Background Tasks**: [Cloudflare Queues](https://developers.cloudflare.com/queues/) для таймаутів капчі.
- **UI**: Vanilla JS + Tailwind CSS, розгортається як Cloudflare Workers Static Assets з `public/admin/index.html`.
- **Security**: Інтеграція з Cloudflare Zero Trust (Access) для захисту панелі керування.

## Швидкий запуск

Повна інструкція з розгортання знаходиться у файлі [DEPLOYMENT.md](DEPLOYMENT.md).

1. **Створення інфраструктури**:
   ```bash
   wrangler d1 create telegram_antispam
   wrangler queues create anti-spam-delay-queue
   ```
2. **Конфігурація**: Вкажіть отримані `database_id` у `wrangler.toml`.
3. **Деплой**:
   ```bash
   npm install
   npm run types
   npx wrangler deploy
   ```
   Якщо змінювали Tailwind-класи в адмін-панелі, спочатку перебудуйте статичний CSS:
   ```bash
   npm run build:css
   ```
4. **Налаштування**: Перейдіть за посиланням воркера `/admin`, введіть токен бота та додайте рядки призначень `ID чату` + `ID адміністратора / адміністраторів`.

Щоб знайти ID груп, додайте бота в потрібні чати та напишіть йому в приват:

```text
/chats
```

## Безпека адмін-панелі

Проект спеціально не містить внутрішньої системи логіну. Шляхи `/admin` та `/admin/*` **обов'язково** мають бути захищені через Cloudflare Access (Application + Policy). Це надійніше і дозволяє використовувати ваші існуючі identity-провайдери.

---

# Telegram Anti-Spam Bot (English)

This project is a Telegram anti-spam bot built on Cloudflare Workers, using D1 for database and Queues for robust captcha processing. It supports multiple chats and per-admin chat assignments.

![Dashboard Screenshot](Screenshot.png)

## Key Features

- **Text Normalization**: Effectively handles spam that uses homoglyphs, hidden Unicode characters, and other evasion techniques.
- **Two-tier Filtering**:
  - **Blacklist (Hard match)**: Immediate message deletion and user ban. Supports plain text and RegEx.
  - **Quarantine (Soft match)**: Suspicious messages are held for manual review in the dashboard.
- **Pre-moderation (Captcha)**: New users must solve a simple text-based captcha. Powered by Cloudflare Queues for reliable timeout handling.
- **Safe Mode**: Test your settings without actually deleting messages or banning users.
- **Multi-chat Support**: Assign one admin to many chats, many admins to many chats, or many admins to one chat.
- **Known Chat Discovery**: Admins can send `/chats` to the bot privately to list non-private chats seen by the bot.
- **Modern Dashboard**: Real-time logs, blacklist management, quarantine moderation, and multi-chat assignment management.
- **Production Tailwind Build**: Dashboard styles are compiled into a static CSS asset instead of loading `cdn.tailwindcss.com` at runtime.
- **Write-only Token UI**: The bot token is not returned to the dashboard after it is saved.
- **Cloudflare Zero Trust**: Protect the dashboard with Cloudflare Access.

Refer to [DEPLOYMENT.md](DEPLOYMENT.md) for detailed setup instructions.
