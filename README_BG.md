# DAVID Smart Cursor v1

Това е първата цялостна основа на DAVID Cursor:

- прозрачен Electron overlay;
- оригинален плавен cursor trail;
- команден панел с `Ctrl+Shift+D`;
- локална библиотека от skills;
- автоматично търсене на подходящ skill;
- Supabase Auth, Postgres и Realtime;
- Supabase Edge Function `teacher-plan`;
- GPT Teacher, който генерира версия на skill;
- локално изпълнение и тест;
- връщане на резултата в Supabase;
- автоматичен upgrade при неуспешен тест;
- локално запазване на успешния skill;
- защитен DAVID Browser без Node достъп;
- опционални Windows click/type действия с потвърждение;
- готов Electron Builder скрипт за `.exe`.

## 1. Най-бърз тест без Supabase

1. Инсталирай Node.js LTS.
2. Разархивирай проекта.
3. Стартирай:

```bat
scripts\install-and-run.bat
```

4. Натисни `Ctrl+Shift+D`.
5. Напиши:

```text
otvori yt i pusni 2pac
```

Без Supabase приложението използва локален demo teacher само за този YouTube тест.

## 2. Свързване със Supabase

### A. Създай Supabase проект

В Supabase Dashboard създай нов проект.

В `Authentication → Providers` включи **Anonymous Sign-ins**, или въведи реален email/password в `.env`.

### B. Създай таблиците

Постави съдържанието на:

```text
supabase/migrations/001_david_teacher_loop.sql
```

в Supabase SQL Editor и го изпълни.

### C. Deploy на Edge Function

С Supabase CLI:

```powershell
supabase login
supabase link --project-ref ТВОЯТ_PROJECT_REF
supabase functions deploy teacher-plan
```

Добави secrets:

```powershell
supabase secrets set OPENAI_API_KEY=ТВОЯТ_OPENAI_KEY
supabase secrets set OPENAI_MODEL=gpt-5-mini
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=ТВОЯТ_SERVICE_ROLE_KEY
```

API ключът на OpenAI стои само в Edge Function. Не го слагай в Electron `.env`.

### D. Настрой `.env`

Копирай:

```text
.env.example → .env
```

Попълни:

```env
SUPABASE_URL=https://ТВОЯТ_PROJECT.supabase.co
SUPABASE_PUBLISHABLE_KEY=ТВОЯТ_PUBLIC_KEY
SUPABASE_TEACHER_FUNCTION=teacher-plan
```

После:

```bat
npm install
npm test
npm start
```

## 3. Build на Windows `.exe`

Стартирай:

```bat
scripts\build-exe.bat
```

Инсталаторът ще се появи в:

```text
dist\
```

## 4. Как работи Teacher Loop

```text
Команда
  ↓
Local Skill Matcher
  ↓ няма skill
training_requests в Supabase
  ↓
teacher-plan Edge Function
  ↓
OpenAI Responses API
  ↓
skill_versions + training_jobs
  ↓
Electron изпълнява
  ↓
training_runs
  ↓
успех → local_verified
провал → GPT получава last_run и създава следваща версия
```

## 5. Безопасност

По подразбиране:

```env
DAVID_ENABLE_NATIVE_ACTIONS=false
```

Така DAVID може да управлява само защитения DAVID Browser и безопасните `open_url/open_app` действия.

За desktop click/type:

```env
DAVID_ENABLE_NATIVE_ACTIONS=true
```

Всяко `system_click` и `system_type` показва отделен прозорец за разрешение.

В Edge Function не са разрешени:

- shell команди;
- PowerShell от модела;
- произволен JavaScript/eval;
- download-and-run;
- изтриване на файлове;
- автоматични плащания, пароли и 2FA.

## 6. Важна граница на v1

DAVID v1 може надеждно да се учи върху уеб интерфейси чрез CSS selectors.

За универсално управление на произволни Windows програми следващият слой е:

- screen capture;
- OCR/vision locator;
- запис на демонстрация;
- UI Automation accessibility tree;
- визуална проверка след всяка стъпка.

Основата за versioning, тестове, Supabase памет и GPT Teacher вече е изградена в този проект.
