# Хостинг `api` і атестаторів (T059)

Де живуть воркери, як вони влаштовані, і як оновити або підняти все з нуля.
`web` — окремо, на GitHub Pages.

---

## Поточний стан

| | |
|---|---|
| Машина | Hetzner Cloud **CAX11** (Arm64, 2 vCPU, 4 ГБ, 40 ГБ), Helsinki, ~€6,49/міс разом з IPv4 |
| Адреса | `204.168.183.173` · `https://204-168-183-173.sslip.io` |
| ОС | Ubuntu 24.04 LTS, автоматичні оновлення безпеки (`unattended-upgrades`) |
| Рантайм | Node **v26.3.0** (офіційний тарбол, SHA256 звірено), pnpm 9.15.0, Caddy 2.11 |
| Мережа | firewall Hetzner `mandate-web` і `ufw`: вхідні лише 22, 80, 443 |
| SSH | лише ключ (`PasswordAuthentication no`); ключ — поза репо, у власника |
| Процеси | `mandate-api` (REST + індексатор, :3000 за Caddy), `mandate-attestor@1..3` (heartbeat на :4101…4103, лише loopback) |

**Чому VM, а не платформа.** Рішення власника 2026-10-06/07 (`TASKS.md` → T059):
атестатор, що засинає без HTTP-трафіку, — сторож, якого будить чужий будильник.
Render Free дає 750 год/міс (рівно один сервіс) і засинає за 15 хв тиші; Railway
free немає; Oracle Always Free не пустив на реєстрації. На VM кожен атестатор —
окремий процес із одним ключем, як окрема сторона: падіння чи нестача пам'яті
одного не забирає інших голосів.

## Розкладка на машині

```
/opt/mandate/app/            клон Mandate210/mandate (лише читання з GitHub), власник mandate
/etc/mandate/common.env      SOLANA_RPC_URL, SOLANA_WS_URL, SOLANA_CLUSTER, PROGRAM_ID
/etc/mandate/api.env         DATABASE_URL (pooler :6543), PORT, ATTESTOR_HEALTH_URLS
/etc/mandate/attestor-N.env  ATTESTOR_KEYPAIR (base58), ATTESTOR_HEALTH_PORT,
                             ATTESTOR_SWEEP_SECONDS (600 у першого, 0 в решти)
/etc/systemd/system/         копії deploy/systemd/*.service
/etc/caddy/Caddyfile         копія deploy/Caddyfile
```

`/etc/mandate/*.env` — `root:mandate`, `640`. У репо їх немає й не буде; збираються з
локального `.env` і `devnet-state.json`, на екран друкуються лише імена змінних.

Сервіси працюють від системного користувача `mandate` під `ProtectSystem=strict`,
`ProtectHome`, `PrivateTmp`, `NoNewPrivileges`; `MemoryMax` — 700M для `api`, 500M на
атестатор. Запуск — `node --import tsx src/index.ts`, як `pnpm census` і `pnpm dev`:
пакети робочого простору віддають TypeScript.

**Підмітання прострочених інцидентів** (T071) увімкнене лише в `attestor@1`:
інструкції безпідписантні, і трьом підмітальникам нема що ділити, крім комісій.

**`TRUSTED_PROXY_HOPS = 0`.** Caddy не довіряє жодному проксі й замінює будь-який
`x-forwarded-for` від клієнта на одну адресу — самого клієнта. На Render було 1.

## Виміряно на машині (2026-10-07, перший деплой `35633bb`)

- `GET https://204-168-183-173.sslip.io/health` → 200: три атестатори `ok`, `lag_slots` 0,
  `quorum_needed` 2, `quorum_alive` true; індексатор — 100 слотів позаду, перший перепис
  записав 24 протоколи, 24 пули, 62 поліси, 60 інцидентів.
- Пам'ять: `api` 106 МБ, атестатори 88–90 МБ кожен; на машині зайнято 719 МБ із 3,8 ГБ.
- Arm64: `bigint-buffer` без зібраного модуля пише «pure JS will be used» — очікувано;
  `bufferutil` і `utf-8-validate` стали.
- Ліміт запитів за Caddy: 100 паралельних запитів, кожен із підробленим
  `x-forwarded-for`, — 61 пройшов за 1,6 с (60 + поповнення), решта 429: **один кошик**,
  підробка свіжої квоти не дає. Контроль на самій машині: після осушення кошика з IPv4
  наступний запит з IPv4 — 429, з IPv6 у ту саму мить — 404: кошики окремі, ключ —
  справжня адреса клієнта, а не `127.0.0.1` Caddy.

## Оновлення

```bash
ssh root@204.168.183.173 'bash /opt/mandate/app/deploy/update.sh'
```

`deploy/update.sh`: `git merge --ff-only origin/main` → `pnpm install --frozen-lockfile`
→ юніти й Caddyfile → `mandate-api` → атестатори **по одному**, кожен чекаємо до
зеленого heartbeat (startup-звірка пройшла), тож кворум під час деплою не зникає.
Якщо атестатор не позеленів за 120 с — скрипт зупиняється, решта лишаються на старому
процесі, журнал друкується.

Перевірка після оновлення:

```bash
curl -s https://204-168-183-173.sslip.io/health      # 200, усі три атестатори ok
ssh root@… 'journalctl -u mandate-attestor@1 -n 50 --no-pager'
ssh root@… 'systemctl status mandate-api "mandate-attestor@*" --no-pager | grep -E "●|Memory"'
```

## З нуля

1. Hetzner Cloud: CAX11 (або будь-яка Arm64/x86 з ≥ 2 ГБ), Ubuntu 24.04, IPv4+IPv6,
   SSH-ключ, firewall: вхідні TCP 22/80/443 і ICMP.
2. Базове налаштування від root: оновлення; `ufw` (22, 80, 443); `sshd_config.d/00-mandate.conf`
   з `PasswordAuthentication no`, `KbdInteractiveAuthentication no`,
   `PermitRootLogin prohibit-password` — **`00-`, бо sshd бере перше значення, а
   cloud-init кладе `50-cloud-init.conf` з `PasswordAuthentication yes`**;
   `useradd --system --create-home --home-dir /opt/mandate mandate`;
   `install -d -m 750 -o root -g mandate /etc/mandate`.
3. Пакети: `git curl ufw xz-utils libatomic1` — **`libatomic1` обов'язковий: без нього
   Node на Arm64 падає `libatomic.so.1: cannot open shared object file`**, а
   мінімальний образ Hetzner його не має.
4. Node: `node-vX-linux-arm64.tar.xz` з nodejs.org, звірити з `SHASUMS256.txt`,
   розпакувати в `/usr/local`. Версія — та сама, що локально. pnpm — `npm i -g pnpm@<packageManager>`
   (corepack у Node 25+ немає).
5. Caddy — з офіційного apt-репозиторію (`dl.cloudsmith.io/public/caddy/stable`).
6. `/etc/mandate/*.env` — п'ять файлів, як у розкладці вище.
7. `sudo -u mandate git clone https://github.com/Mandate210/mandate.git /opt/mandate/app`,
   далі `bash /opt/mandate/app/deploy/update.sh`.
8. На 24.04 `sshd -t` поза запущеним сервісом просить `/run/sshd` — `mkdir -p /run/sshd`
   перед перевіркою конфігу.

## Моніторинг

UptimeRobot (акаунт власника) на `https://204-168-183-173.sslip.io/health`, кожні 5 хв:
503 означає, що відстав індексатор або замовк хоч один атестатор
(`PLAN.md` → «Живість атестатора (T069)»).

**Ланцюг тривоги перевірено наживо 2026-10-07:** `mandate-attestor@3` зупинено на 7 хв
(запуск назад — таймером `systemd-run --on-active=420`, щоб не залежати від нас);
`/health` → 503, атестатор `unreachable`, `quorum_alive: true`; власнику прийшли листи
«Monitor is DOWN» і після запуску «Monitor is UP». Повторювати після зміни монітора
або адреси.
