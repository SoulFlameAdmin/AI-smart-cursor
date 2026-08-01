# DAVID Security v1

1. `nodeIntegration=false`.
2. `contextIsolation=true`.
3. `sandbox=true` за renderer и DAVID Browser.
4. OpenAI secret key не влиза в Electron.
5. Supabase service-role/secret key не влиза в Electron.
6. Electron използва само publishable key + RLS.
7. Teacher връща само действия от allowlist.
8. URL действията приемат само `http:` и `https:`.
9. Няма shell action в skill schema.
10. Native desktop click/type са изключени по подразбиране.
11. Native desktop действията искат локално човешко потвърждение.
12. Успешният skill се пази локално и се version-ва в Supabase.

Това е основа, не пълна production sandbox. Преди публично пускане добави code signing, auto-update signing, rate limiting, audit logs и отделно одобрение на high-risk skills.
