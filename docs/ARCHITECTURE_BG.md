# Архитектура DAVID Teacher Loop v1

## Electron

`main.cjs` държи всички привилегировани операции. Renderer-ът няма Node.js достъп.

Прозрачният overlay е click-through. Позицията на мишката се взема от Electron `screen.getCursorScreenPoint()` и се изпраща към canvas анимацията.

Командният панел се отваря с `Ctrl+Shift+D`. Само докато панелът е отворен, overlay прозорецът приема mouse/keyboard input.

## Skill

Skill definition съдържа:

```json
{
  "skill_key": "youtube_play_search_result",
  "version": 1,
  "risk_level": "low",
  "matcher": {
    "type": "regex",
    "pattern": "...",
    "flags": "iu",
    "variables": ["query"]
  },
  "steps": []
}
```

Шаблони:

```text
{{query}}      → суров текст
{{url:query}}  → URL encoded текст
```

## Supabase

- `devices` — компютрите на потребителя;
- `training_requests` — непознатите команди;
- `skills` — логически способности;
- `skill_versions` — версии, създадени от GPT;
- `training_jobs` — задача към конкретен Electron device;
- `training_runs` — реалният тест и логовете.

Всички таблици са с RLS по `owner_id = auth.uid()`.

## Teacher

Edge Function валидира Supabase JWT, зарежда training request и изпраща ограничена задача към OpenAI Responses API.

Моделът няма право да връща изпълним код. Той връща само JSON с действия от allowlist.

## Upgrade

При неуспех Electron изпраща `last_run`, включително failed step и error. Teacher създава нова версия. Максималният брой опити се контролира от:

```env
DAVID_MAX_TRAINING_ATTEMPTS=3
```
