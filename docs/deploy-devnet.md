# Деплой на devnet — T063

Ручна процедура. Без CI і без хостингу застосунків (той у T059). Кожен крок
відтворюваний; числа в тексті — виміряні, а не оцінені.

**Статус на 2026-08-13:** ✅ **програма задеплоєна й ініціалізована на devnet** —
усі кроки виконані й перевірені на ланцюгу. Набір атестаторів прийнятий і голосує
з епохи 1120; до неї — крок 7.

---

## Що фіксується назавжди

Три речі після цього деплою вже не змінити, і кожна з них — рішення власника,
ухвалене 2026-08-13:

| Що | Значення | Чому не змінити |
|---|---|---|
| Адреса програми | `DsRdHv4QRYQ7teVhwuLVttktF792gvDFQdiuraQ4eF4P` | ключ у `target/deploy/`, який у `.gitignore`; втрата = інша адреса |
| `Config.declaration_delay` | **30 с** | `Config` — синглтон PDA `["config"]`, інструкції зміни параметрів у програмі немає, а на devnet немає `--reset` |
| Upgrade authority | `EktFLdpBnTNLRMSmLiAkKPZt7KQTZ9hrbDcJP2947Mjf` | до mainnet переводиться на мультисиг — R-1, рунбук у `deploy-mainnet.md` (T062) |

**Затримка 30 с, а не продуктові 24 год — свідомо.** Критерій готовності M1
(`TASKS.md` → «M1») вимагає, щоб `scenarios/compromise.ts` проходив **на devnet**
за ≤3 хв, а T029 міряв там же SC-001. Три з десяти компрометацій сценарію і його
контрольний випадок тримаються на записі декларації, що **набув чинності**, — із
затримкою 86 400 с жоден із них у тривилинний прогін не вкладається, і сценарій
сам падає з поясненням ([`scenarios/compromise.ts:136`](../scenarios/compromise.ts#L136)).
Продуктове значення FR-031 дістанеться mainnet-деплою, де `Config` буде свій.
**Це треба казати вголос на демонстрації:** devnet показує механізм, а не
продуктовий календар.

Решта параметрів `Config` беруться з того самого набору сценарію і теж
незмінні: `attest_window` 90 с, `quorum_bps` 6000, `open_bond` 1 000 000.

---

## Ключі

Обидва лежать **поза репозиторієм**, у `%USERPROFILE%\.secrets\drain-cover\`:

| Файл | Що це | Робоча копія |
|---|---|---|
| `drain_cover-keypair.json` | ключ програми — визначає її адресу | `target/deploy/drain_cover-keypair.json` |
| `devnet-deployer.json` | платник деплою й upgrade authority | `~/.config/solana/drain-cover-devnet-deployer.json` (WSL) |

Бекап ключа програми — **умова, а не гігієна**: `target/` у `.gitignore`, тож
очистка каталогу змушує `anchor keys sync` намінтити іншу адресу й осиротити все
задеплоєне. Відновлення — покласти файл назад у `target/deploy/` **до** `anchor deploy`.

Платник деплою виділений навмисно, а не взятий із `~/.config/solana/id.json`:
той існує лише всередині WSL без жодної копії, і його втрата означала б програму,
яку неможливо апгрейдити (T070 як мінімум), і `Config.admin`, яким неможливо керувати.

---

## Крок 1 — збірка

`anchor build` сам по собі віддає програму, яка **не задеплоїться**:
`cargo-build-sbf` за замовчуванням `--arch v0`, а кластери з чинними фічами
відмовляють v0 (`PLAN.md` → R-10). Два кроки, саме в цьому порядку — другий
перезаписує `.so`, який написав перший:

```bash
wsl -e bash -lc "cd <repo> && anchor build"
wsl -e bash -lc "cd <repo> && cargo build-sbf --manifest-path programs/drain-cover/Cargo.toml --arch v3"
```

Перевірка, що артефакт справді v3 — читається з ELF, а не з віри в порядок команд:

```bash
wsl -e bash -lc "readelf -h <repo>/target/deploy/drain_cover.so | grep -i flags"
# Flags: 0x3, CPU Version: 3
```

Виміряно 2026-08-13: `drain_cover.so` — **420 760 байтів**, `CPU Version: 3`.

## Крок 2 — звірка адреси

```bash
wsl -e bash -lc "solana address -k <repo>/target/deploy/drain_cover-keypair.json"
# DsRdHv4QRYQ7teVhwuLVttktF792gvDFQdiuraQ4eF4P
```

Має збігтися з `declare_id!`, обома кластерами в `Anchor.toml` і `PROGRAM_ID` у
`.env.example` — усі три місця стереже `tests/config-consistency.test.ts`.
**`anchor keys sync` тут не запускати:** він переписує лише налаштований кластер
і при розбіжності зіпсує другий.

## Крок 3 — фінансування

Рента за програмний акаунт, виміряна на devnet (`solana rent`):

| `max_len` | Байтів | Рента |
|---|---|---|
| `2 × len + 45` — типовий для `anchor deploy` | 841 565 | **5.858 SOL** |
| `len + 45` — точна довжина | 420 805 | **2.930 SOL** |

**Жоден faucet не дав нічого** — ні на 2, ні на 1, ні на 0.5, ні на 0.1 SOL, на
двох різних адресах. Кластер при цьому живий (`cluster-version` відповідає), тобто
впиралося саме у faucet. Причина не «сервіс лежить», а стеля:

| Джерело | Стеля | Сира відповідь |
|---|---|---|
| `api.devnet.solana.com` | ~2 SOL/добу на IP | `429 · You've either reached your airdrop limit today…` |
| Helius devnet | **1 SOL/добу на проєкт** | `-32403 · The devnet faucet has a limit of 1 SOL per project per day` |

Помилка планування, варта запису: Helius обрали **саме** заради нібито окремого
faucet-ліміту, а він виявився вчетверо меншим за публічний і вдвічі меншим за
`faucet.solana.com`. Перевіряти стелю треба було до вибору, а не після.
Як RPC для T029, атестатора й API Helius лишається — це рішення не скасовується.

**Як профінансовано насправді:** власник переказав **5 SOL вручну** на
`EktFLdpBnTNLRMSmLiAkKPZt7KQTZ9hrbDcJP2947Mjf`. Це і є робочий спосіб; faucet'и
для суми такого порядку не годяться в принципі — 2.93 SOL це три доби збирання.

**Рішення власника 2026-08-13 — точна довжина, `--max-len 420760`.** Удвічі
дешевше зараз, а рента на devnet усе одно нікому не повертається, поки програма
жива. Ціна рішення записана нижче й важлива.

> ⚠️ **Перед першим апгрейдом, що збільшує `.so` бодай на байт** — а T070 саме
> такий — потрібен `solana program extend DsRdHv4QRYQ7teVhwuLVttktF792gvDFQdiuraQ4eF4P
> <додаткових_байтів> -u devnet`. Без нього `solana program deploy` відмовить.
> Доплачується лише різниця ренти.

## Крок 4 — деплой

`Anchor.toml` лишається на `cluster = "localnet"` — його читає локальний цикл
інтеграційних тестів, і перемикати його заради разової операції означало б
залишити міну під наступною сесією. Кластер, гаманець і довжина передаються
явно, тому тут `solana program deploy`, а не `anchor deploy`: обгортка ховає
саме ті три параметри, які в цьому деплої нетипові.

```bash
wsl -e bash -lc "cd <repo> && solana program deploy \
  target/deploy/drain_cover.so \
  --program-id target/deploy/drain_cover-keypair.json \
  --keypair ~/.config/solana/drain-cover-devnet-deployer.json \
  --url devnet \
  --max-len 420760"
```

`--max-len` рахується від довжини `.so`; 45 байтів заголовка акаунта додаються
понад це, звідси 420 805 байтів у таблиці ренти вище.

Якщо деплой обірветься на середині, буфер лишається оплаченим і його видно в
`solana program show --buffers --keypair ~/.config/solana/drain-cover-devnet-deployer.json
-u devnet`. Продовжити — `--buffer <адреса>`; кинути й забрати ренту —
`solana program close <адреса>`. На devnet, де кожен SOL здобувається вручну,
загублений буфер коштує повторного походу по faucet.

Перевірка після:

```bash
wsl -e bash -lc "solana program show DsRdHv4QRYQ7teVhwuLVttktF792gvDFQdiuraQ4eF4P -u devnet"
```

Дивитися треба на три поля: `ProgramData Address` (є = деплой пройшов),
`Authority` (має бути `EktFLdp…`) і `Last Deployed In Slot`.

## Крок 5 — `Config` ✅ створений 2026-08-13

Одноразово й назавжди, скриптом `pnpm --filter @drain-cover/scenarios devnet:setup`.

| | |
|---|---|
| `Config` PDA | `E6p1VaW7wtvXX5saT1TjTayWVCTzXaE7vnSbKNkBeHKv` |
| `admin` | `EktFLdpBnTNLRMSmLiAkKPZt7KQTZ9hrbDcJP2947Mjf` — той самий ключ, що платив за деплой |
| `asset_mint` | `D7ucvLoxVmotii7izgwLwbgqMCEiDPuY97Zfybv56Uzx` — власний SPL-мінт, 6 знаків |
| `declaration_delay` | **30 с** |
| `attest_window` | 90 с |
| `quorum_bps` | 6000 |
| `open_bond` | 1 000 000 базових одиниць |

**Мінт наш власний, а не devnet-USDC** — рішення власника. Пул, премії, застави й
казну бенефіціара треба наповнювати на кожному прогоні, а чужий faucet із власними
лімітами вже коштував нам пів дня на кроці 3. Ціна: доларова одиниця тут наша, і на
демонстрації це треба назвати вголос — так само, як і затримку 30 с.

Скрипт ідемпотентний: на повторному запуску він читає наявний `Config` і **відмовляє**,
якщо затримка чи мінт не ті, замість тихо продовжити з чужими параметрами.

## Крок 7 — атестатори й чому вимір не сьогодні

`devnet:setup` прийняв три атестатори (кворум 2 з 3). Їхні ключі — у
`devnet-state.json` поруч із рештою, бо вимір відбувається в **іншій** сесії:

> **Епоха devnet — 432 000 слотів, тобто ~32 години.** FR-008 допускає атестатора до
> голосування з епохи, **наступної** за тією, в якій його прийняли. Прийняті в епосі
> 1119 — голосують з 1120. Це не наша повільність, а правило програми, і обійти його
> можна лише зламавши FR-008.

Тому T029 розділена на два запуски, а не один скрипт, що вдає зависання на добу:

```bash
pnpm --filter @drain-cover/scenarios devnet:setup     # один раз, зроблено
pnpm --filter @drain-cover/scenarios devnet:measure   # після межі епохи
```

`devnet:measure` сам перевіряє, чи вже можна голосувати, і якщо ні — каже, скільки
лишилося, рахуючи з **виміряного** темпу слота, а не з цільових 400 мс (devnet іде
помітно швидше, і на константі 400 мс відповідь була б на пів доби більшою).

## Крок 6 — результат

**Деплой виконаний 2026-08-13.**

| | |
|---|---|
| Program Id | `DsRdHv4QRYQ7teVhwuLVttktF792gvDFQdiuraQ4eF4P` |
| ProgramData | `8diP1FWsLiEL1owXJnfrH982b5b7JpEzCJk3a2T2o9xm` |
| Authority | `EktFLdpBnTNLRMSmLiAkKPZt7KQTZ9hrbDcJP2947Mjf` |
| Сигнатура | `3PaVaym82ZEoHSMRcLypi9JwhSPF5ryZ7xisXS9ghMmmhHBsKgZ8GerGV329CNaAd5MtTfSwwJWKPTxNUTU6ozjS` |
| Слот | 483 463 135 |
| Data Length | 420 760 Б — рівно `--max-len`, без запасу |
| Рента | 2.929 693 68 SOL — збіглася з прогнозом `solana rent` до ламорта |

Explorer:
`https://explorer.solana.com/address/DsRdHv4QRYQ7teVhwuLVttktF792gvDFQdiuraQ4eF4P?cluster=devnet`

Перевірено після деплою: `solana program show --buffers` порожній — обірваних
буферів не лишилося. Залишок у платника — 2.067 SOL, його вистачає на `Config`,
мінт і токен-акаунти кроку 5, але **не** на `extend` під великий апгрейд.

Далі — крок 5, у якому `Config` уже створений.

---

## Далі

**T029** — вимір SC-001 на devnet. Тримати в голові: 2.1 с зі сценарію T028
виміряні на локальному валідаторі з майже нульовою латентністю й без конкуренції
за блокпростір, тож на devnet вони не переносяться — саме цю різницю T029 і міряє.
