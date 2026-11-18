# OPEN_VERCEL — ограничено умение за DAVID Smart Cursor

## Вградено поведение
- Командите `отвори Vercel`, `otvori vercel.com` и `open vercel` използват фиксиран URL: `https://vercel.com/`.
- Прозорецът е **вграденият DAVID Browser** (Electron) в AI-smart-cursor, не външен Microsoft Edge.
- `browser_open` изчаква зареждането; `verify_url_exact` сравнява пълния зареден адрес. При redirect, login или различен URL операцията се отчита неуспешна.
- Без въвеждане на команди, shell/PowerShell, login, deploy или клик върху интерфейса; не приема свободно подаден URL.

## Тестове
`npm test` проверява фиксирания URL, Bulgarian/Latin matching, забранени допълнителни заявки и отхвърляне на redirect към различен origin/път. Тестовете **не доказват** реално отваряне на сайта на Windows.

## Интеграционна граница
Действа само след code review и инсталиране/стартиране на ново издание на **AI-smart-cursor**. Няма връзка с работещия `D:\\ASI\\DAVID-JARVIS-WINAPP-V4` Guardian worker, който чете GitHub Issue #102: локалният му код не е в това GitHub дърво. 
За да изпълнява `OPEN_VERCEL` от Issue #102 в **Edge**, трябва отделен локално одобрен Guardian/JARVIS WinAppCLI patch с pinned SHA-256, backup, STOP, nonce/TTL, точна проверка на Edge CDP target плюс WinAppCLI HWND, журнал и rollback. **Няма автоматично инсталиране и няма самостоятелно натискане на Guardian Yes.**

Този PR не е доказателство за изпълнение на `OPEN_VERCEL` на собствения Windows компютър.
