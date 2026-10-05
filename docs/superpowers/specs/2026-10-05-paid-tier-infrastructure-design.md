# Paid-Tier Infrastructure — Design Spec

**Date:** 2026-10-05
**Status:** Approved design, not yet implemented
**Scope:** The *enabling infrastructure* for charging money. Deliberately does **not**
define which features go behind the paywall — that decision comes later, once the
core/extras split is written down and the hosting evidence is in.

**This is an umbrella spec, not a single implementation plan.** It spans seven parts across
legal compliance, infrastructure, authentication and a debugging investigation. Each part
(Parts A–G, §4–§10) becomes its own implementation plan with its own approval gate, built in
the order given in §14. Nothing here should be implemented straight from this document.

---

## 1. Goal

Make it possible to charge Val's existing ~100 enrolled families for extra access to
Classroom-survivors, without breaking the free experience, without taking on Chinese
education licensing he cannot obtain, and without spending money on infrastructure
before there is evidence about what is actually slow.

Three things must be true before the first payment is taken:

1. A parent can pay and get access, and Val can grant/extend/revoke that access himself.
2. Credentials are no longer stored or cached in plain text, and a parent can recover
   access without Val reading a password back to them.
3. The known end-of-session data loss is understood and fixed — not merely quieter.

---

## 2. Decisions already made

Recorded here because each one constrains the design and several were chosen over
plausible alternatives.

| # | Decision | Alternative rejected | Why |
|---|---|---|---|
| D1 | **The ladder** — manual fulfillment now, automate later | Domestic WeChat Pay merchant account under a software/tools category | Category mismatch is an audit risk. "We're an audit away from being in trouble." |
| D2 | **One-off blocks of time** | Monthly auto-renewal | Auto-renewal needs a signed 委托代扣 agreement; Stripe cannot do recurring on Chinese wallets at all (private preview). |
| D3 | **Per student** entitlement | Per family, per class | Matches the existing data model exactly; no sibling-linking needed. |
| D4 | **Honor-system gating** | API-served content, or server-side-only features | Adequate for an audience of parents, not pirates. Frees effort for reliability instead. |
| D5 | **Extras lock, core keeps working** on expiry | Hard lock, notice-only, grace period | Never takes a child's toys away because of an adult's admin. |
| D6 | **Recovery question** as primary self-service | Recovery code issued at enrolment, SMS, WeChat OAuth | Self-service, instant, no phone numbers collected, no third party. SMS and WeChat OAuth need machinery Val is avoiding. |
| D7 | **WeChat-delivered temporary passwords** as fallback | SMS delivery | No phone-number collection, no Aliyun signature/template approval queue. |
| D8 | **Measure before migrating** hosting | Straight to EdgeOne, or straight to a HK VPS | The EdgeOne custom-domain premise was never tested. Risk of paying for the wrong thing twice. |
| D9 | **No personal WeChat automation** | Wechaty / WeChatFerry / PC-client hooks | ToS violation; permanent ban risk lands on the account holding the relationship with 100 families. |

---

## 3. Constraints shaping the design

**Licensing.** Chinese entities exist and are not the blocker. Education licensing is.
Three separate gates, all avoided rather than won:

- **ICP filing** — only applies to servers physically in the mainland. "教育" is a
  pre-approval category, so a mainland-hosted education site needs provincial education
  department sign-off before the filing is granted. Hosting outside the mainland means
  no filing and no pre-approval.
- **教育App备案** — targets K-12 subject-tutoring apps in Chinese app stores. A website
  in a browser never enters that pipeline.
- **WeChat Pay / Alipay merchant category** — the 教育 category wants a 办学许可证.
  Software/tools categories key off business scope instead. **Deliberately not pursued**
  (D1) because Val is selling education-adjacent product and a mismatch is auditable.

**Consequence for phase 3:** the audit risk does not shrink with scale, it grows with
revenue. Later options are Stripe/Paddle for non-China buyers, or a Chinese distributor
acting as merchant of record so the category problem is theirs. Also note only a Chinese
entity can issue a **fapiao**, which schools will require — a hard ceiling on the schools
segment while billing overseas.

**Copyright.** Teaching content is derived from Cambridge *Think 0/1/2*. Free classroom
use and paid access are materially different exposures. The paid tier should be built on
Val's own **PU** series. Not a legal opinion; a risk-posture decision.

**Network.** Users are in mainland China, mostly inside WeChat's webview. GitHub Pages is
GFW-throttled. WeChat's WKWebView evicts cache aggressively. No ICP filing means no
mainland CDN nodes, ever — the ceiling is a well-peered overseas edge.

---

## 4. Part A — Entitlement and the day balance

### 4.1 Data model

Add to the student document (`Val-EslApp` / `Students`):

```
premiumUntil:  <ISO timestamp> | null    // instant access ends
premiumGrants: [ ... ]                    // optional inline history, capped
```

`premiumUntil` is a **timestamp, not a boolean and not a day count**. Val's requirement is
a balance he can add to; a date expresses that directly.

**Day boundaries are Asia/Shanghai (UTC+8, no DST).** "30 days" means 30 calendar days of
use for a child in Kunming. Store the expiry as end-of-day in Asia/Shanghai — i.e.
`23:59:59+08:00`, which is `15:59:59Z`. Without this a child gets locked out mid-lesson
at 08:00 UTC. All arithmetic and all display must go through one shared helper so the
timezone is defined in exactly one place.

### 4.2 The grant operation

One operation, `grantDays(studentId, n, meta)`:

```
base = max(premiumUntil, endOfTodayShanghai)   // expired → restart from today
premiumUntil = base + n days                   // active → extend, never overwrite
```

This satisfies the worked example exactly: student A buys 30 days; on day 5 a bug makes
the paid experience bad; Val adds 2 free days on top of what remains. `n` may be negative
for corrections, and may be 0 for a no-op.

Time is **calendar time, not usage time** — the balance does not pause when a child is
ill. State this in the parent-facing terms so it is not a surprise.

### 4.3 Reaching the client

`publicUser()` already passes unrecognised document fields through to the client, so
`premiumUntil` arrives on the login response with **no new endpoint**. The frontend gates
on `now < premiumUntil`.

Gating is honor-system (D4): a client-side check over data already in the bundle. This is
a convenience barrier, not a security one, and that is accepted.

### 4.4 The core/extras split — required before implementation

D5 says extras lock and core keeps working, which means the code must distinguish them.
**This list does not exist yet and is a product decision, not an engineering one.** It must
be written down before gating is implemented, because it is effectively the definition of
the product. Deliverable: a short table of every user-visible capability marked `core` or
`extra`.

### 4.5 Dashboard controls

In the admin dashboard (where students are already added and passwords edited):

- Per student: **"+N days"** with a reason field, plus a days-remaining display.
- A **days-remaining column** in the student list, colour-coded.
- An **"expiring within 7 days"** filter — turns renewal into a two-minute weekly habit.
- A **"no recovery question set"** filter (see Part C) — the coverage metric.

### 4.6 Ledger

An append-only payments record, one document per grant:

```
{ type: 'payment', studentId, days, amount, currency, method,
  note, grantedBy, grantedAt }
```

`amount: 0` with a note is how goodwill days are recorded. Per-student entitlement plus
manual fulfillment makes disputes Val's word against a parent's memory; a ledger that
reconciles against the collection app's own transaction list is cheap insurance.

---

## 5. Part B — Collecting the money

### 5.1 Rail

A **business collection code** (微信收款商业版, or a bank's 聚合收款码) tied to an existing
entity. Not a personal 收款码: personal codes are barred from commercial collection, and
using your wife's personal account puts that account at risk of a freeze.

This is **not** the API merchant-account integration. No certificates, no callback
endpoint, no JSAPI category registration. It is a standalone collection product with its
own transaction ledger.

**Open question Val must resolve by phone before build:** whether 商业版 asks for a service
category at signup. If it does, and education is the only honest answer, fall back to
bundling into tuition — which has no rail risk at all.

### 5.2 Fulfillment flow

Parent pays → messages Val on WeChat → Val taps "+N days" in the dashboard with a note →
done.

**Operational risk, stated plainly:** with manual fulfillment Val *is* the payment system.
If he is teaching or on holiday, nobody gets unlocked. Decide who covers this. The
delegated-admin mechanism in Part C solves it for passwords and can solve it here too.

### 5.3 Deliberately not built

Order system, checkout page, coupons, pricing page, automated delivery notifications.
One-off blocks, honor-system gating, ~100 families — none of it earns its keep yet.

---

## 6. Part C — Credentials and self-service recovery

### 6.1 Current state (verified in code)

- Passwords are stored **in plain text by deliberate decision** (`SECURITY_AUDIT_HANDOFF.md`
  Finding 6) so Val can read them back to parents over WeChat — there being no email, SMS
  or OAuth available. A rational trade for a free tool; not defensible once money moves.
- `login.js` performs **recovery-on-login**: a stored `scrypt$` hash is overwritten with the
  plain text just typed, so the dashboard can display it.
- `addStudent.js` stores new passwords in plain text.
- `getStudents?includeSecure=true` returns passwords to teacher/BM/admin tokens; the admin
  dashboard reveals them behind an eye-toggle.
- **The browser caches each saved profile including its plain-text password** in
  `localStorage['savedUsers']`, to enable silent re-login. ~96 students' passwords sit in
  browser storage on shared school iPads.
- `changePassword` already hashes with **scrypt**, and a `needsPasswordChange` flag already
  drives a forced change-password screen. Both are reused, not rebuilt.
- The database is already **mixed**: imported/CSV/reset passwords are plain text, older ones
  are still `scrypt$` hashes.

### 6.2 Target: hash everything

Subtraction, not new construction:

1. Remove recovery-on-login from `login.js`.
2. Hash on creation in `addStudent.js`.
3. Stop returning passwords from `getStudents`; delete the eye-toggle.
4. Migrate existing plain-text rows **lazily** — convert on next successful login. The
   mixed-state handling for this already exists.
5. **Stop caching plain text in `localStorage['savedUsers']`.** Cache the session token
   instead: a 30-day JWT is already minted and already re-minted on login. Identical "don't
   make me type it again" UX, nothing sensitive at rest, and it retires
   `trySilentRelogin()`.

`updateStudent.js` has a field **allowlist** which must be extended for every new field
added by Parts A and C. `publicUser()` passes unknown fields through, which is how
`premiumUntil` reaches the client for free — but it also means anything added to the
document is client-visible by default. Check before adding.

### 6.3 Recovery question (primary, self-service)

- **Fixed list of ~10 prompts**; parent picks one and types an answer. Fixed prompts rather
  than free-form questions so the parent only has to remember the *answer* — "which question
  did I pick?" becomes a five-option screen instead of a blank page.
  **The prompt list itself is a deliverable** and needs writing (bilingual, answerable by a
  Chinese parent about a child, and not answerable by a sibling who lives in the same house —
  that last criterion rules out pet names and favourite foods).
- Store `recoveryPromptId` in clear and **only a hash of the answer**. Unlike passwords,
  there is no operational need to read it back, so there is no reason to keep it.
- **Normalization is the main engineering risk** and will be the largest source of "it says
  my answer is wrong" support messages. Apply identically at setup and at verification:
  trim → collapse internal whitespace → lowercase → strip punctuation → fold full-width to
  half-width (`ａ`→`a`) → fold traditional to simplified Chinese. Show the parent their
  exact answer once at setup and require a retype to confirm.
- Rate-limit verification attempts (e.g. 5, then lockout) so the answer cannot be guessed.

**Do not force this at next login.** A child logging in on a shared classroom iPad
mid-lesson who hits a blocking "invent a security question" screen hands the device to the
teacher — and Val fills in eighty of them himself, defeating the purpose. It also lands on
top of a login flow with a known process-kill problem (Part G).

Instead: a **dismissible prompt** at login reading "ask a grown-up to set this up at home",
plus a **dashboard coverage column** showing which families have not set one. That is what
makes "every user has one" converge rather than remain a hope — Val can watch the number
fall and chase stragglers with one message to the parent group.

### 6.4 Temporary password (fallback, Val-delivered)

Reached from "forgot login / forgot my answer":

- A message: *"Ask Val on WeChat for a recovery code — not instant, when he's available."*
- Below it, **Val's WeChat QR code**, for families who do not have his WeChat. Placed behind
  the button tap, not on the page: the site is public, and a personal WeChat QR in plain HTML
  is scrapeable for spam.

Format and lifetime — the lifetime requirement comes from the real async gap. A parent
messages during class, Val replies two hours later, the parent acts two hours after that.
A 15-minute code is useless.

- **Random 8 characters** from an unambiguous alphabet (no `0/O`, `1/l/I`), case-insensitive
  for easy phone entry. ~32⁸ ≈ 1.1×10¹² — comfortable even with a long window. **A six-digit
  code with a 72-hour life would be brute-forceable**, which is why the format changes with
  the lifetime.
- **72 hours, single use.**

Invariants:

- Generating a new one **kills any outstanding one** — never two live temp passwords.
- A successful **normal** login kills it too. Otherwise a stale temp password is a live
  backdoor for three days.
- Stored **hashed**, in its own field with its own expiry, checked **only after** the real
  password check fails.
- On successful temp-password login: invalidate it and set `needsPasswordChange`, so the
  very next screen is "choose a new password". **Reuse the existing flag and screen.**
- Log generation and redemption with the generating admin. That is the audit trail.

**Consequence Val must accept:** the dashboard shows the temporary password **once**, in the
modal, at generation time. It is hashed on the way in and can never be looked up again. Lose
the modal, generate a fresh one. This is the exact inversion of today's "look it up any time"
and it is the whole point — but it will feel like a loss the first time it happens.

### 6.5 Not now

SMS OTP and WeChat OAuth. Both are feasible later and neither is blocked by education
licensing:

- **SMS** needs Aliyun/Tencent enterprise real-name verification (Val has entities), a
  **signature applied for as the company's registered name** — not a brand, website or app
  name, which would invite a request for an ICP filing number — and a **verification-code
  template**, the easiest category to get approved. ~¥0.045/message, days to ~2 weeks.
  Blocked today only because parent phone numbers are not collected and Val chose not to.
- **微信客服 via 企业微信** is the compliant WeChat-native channel and, importantly, carries
  **no payment-category audit risk** — it is a service channel, not a merchant account. It
  would relay to the same API, not perform the reset itself.
- Avoid international SMS (Twilio et al.) into +86: expensive, and verification codes are
  filtered or delayed often enough to be undebuggable.

### 6.6 Parent-facing behaviour change

This is a breaking change in *behaviour*, not just code. The first week will generate
**more** WeChat messages than usual, not fewer, because every parent who relied on Val
reading a password back now needs a code. Announce it once, in advance, and it settles.

---

## 7. Part D — Pre-launch gates

Three things that must be true before any payment is taken.

### 7.1 Confirm `REQUIRE_AUTH` is enabled in production

Auth enforcement is feature-flagged by a `REQUIRE_AUTH` environment variable. When off,
`requireAuth` returns `token: null` and endpoints fall back to **client-supplied student
ids** — in which case every entitlement in this design is decoration, and any caller can
write to any student's record.

**How to check — two independent methods, do both:**

*Method 1, black-box from the live origin (authoritative).* The API's app-key gate
allowlists the GitHub Pages origin with an empty key, so this must run **from the live site
in a browser**, not from curl — curl would be rejected by the key gate and tell you nothing
about the auth gate. On `https://vpietri-stack.github.io/Classroom-survivors/`, logged out,
in the devtools console:

```js
fetch(API_BASE_URL + '/getStudents').then(r => r.status)          // want 401
fetch(API_BASE_URL + '/getStudents?includeSecure=true').then(r => r.status)   // want 401
```

Any `200` means `REQUIRE_AUTH` is off and nothing else in this spec matters until it is on.
**Positive control:** repeat with a valid `X-Auth-Token` from a logged-in teacher session and
confirm it returns data — otherwise a 401 might just mean the endpoint is broken.

*Method 2, configuration.* Azure Portal → Static Web Apps `brave-bush-0438ab000` →
Configuration → Application settings → confirm `REQUIRE_AUTH` is present and truthy. Also
confirm `SESSION_SECRET` is set and is not a default.

Record the result in `docs/wiki/04-auth-versioning.md`.

### 7.2 Privacy policy and consent record — **agent-designed**

Val asked that the agent work out how to do this. The design:

**Policy document.** A `privacy.html` served from the app, in **Chinese** (the audience is
Chinese parents), with an English translation alongside. It must state, at minimum: what is
collected (child's name, login, avatar, class time, book/unit/page, gameplay analytics,
session counts); what is **not** collected; that the data is stored on servers **outside
mainland China** (Azure) — this is the cross-border disclosure PIPL requires; who handles it;
how long it is kept; how to request correction or deletion; and a contact route.

*Honest caveat:* the agent can draft this, but it is not legal advice and a qualified person
should read it before it is published under a paid product.

**Consent capture.** Add to the student document:

```
consent: { v: '1', at: <ISO>, guardian: true } | null
```

- **New registrations:** consent required before the account is created. Non-skippable.
- **Existing students:** a persistent, dismissible banner plus a dashboard column showing who
  has not consented, and a grace period. Do **not** hard-block a child mid-lesson — the same
  reasoning as §6.3. Chase the gap from the dashboard, once, deliberately.
- Store the policy **version**, so that if the policy changes you can tell who agreed to
  which text and re-prompt only those people.

**Deletion — the part that is easy to get wrong.** A parent must be able to say "delete my
child's data" and have it actually be deleted. Today the data is spread across several
document shapes in one container, so deletion must cover all of them:

- the student document itself;
- `type: 'student_analytics_archive'` documents for that student (analytics roll into
  archives at ≥700 events — **a deletion that misses these is not a deletion**);
- references inside `role: 'bmActivity'` logs;
- the client-side `localStorage` queue and cached profile (instruct the parent, or clear on
  next login when the account is gone).

Build this as an admin-only endpoint with a typed confirmation and an audit record of who
deleted what and when. **Test question before launch: if a parent asked tomorrow, could you
delete completely, and prove it?**

**Retention.** Define a window for archived analytics of withdrawn students and enforce it.
PIPL requires retention limited to the minimum necessary; an archive that grows forever is
both a liability and a cost.

### 7.3 Geo data — Val handles this himself

The student document carries `geo` and `geoSamples[]`. Under PIPL, 行踪轨迹 (whereabouts
traces) is named as sensitive personal information in its own right, and **separately** all
personal information of a child under fourteen is classified as sensitive. That field is
therefore doubly sensitive — the most heavily regulated category a Chinese service can hold.

The transfer thresholds are **not** a problem: under the 2024 relaxation, fewer than 10,000
individuals' sensitive personal information crossing the border needs no CAC security
assessment, no standard contract and no certification. At ~100 families that is three orders
of magnitude of headroom.

The obligations that do apply: parental consent (§7.2), published rules specific to minors,
cross-border disclosure, honoring deletion/correction, and **retention limited to the minimum
necessary**.

The geo work appears to have been built for the campus relocation — a commute-planning
exercise rather than a permanent product feature. **If it was a one-off, delete the data.**
You cannot breach data you no longer hold, and minimising retention is a requirement anyway,
not a workaround. *Assigned to Val, deliberately out of scope for implementation.*

### 7.4 Remaining non-technical gates

- **Written refund policy before the first sale.** Chinese consumer law gives a seven-day
  no-reason return right on distance sales; digital goods can be exempt **if disclosed in
  advance**. Disclosing during a dispute loses. One-off blocks make this easy to write.
- **Tax in two countries.** Revenue through a Chinese entity sits on that entity's books;
  revenue into N26 is a French declaration. Ensure the same money is not doing both. Have the
  accountant conversation **before** the first payment, not after the first ¥50,000.
- **Grandfathering.** Existing families have used this free for over a year. If features they
  already have go behind a wall, that is an ugly conversation in the parent group. Decide what
  stays free forever for them and **encode it in the entitlement** so it is not a promise Val
  has to remember.
- **Account sharing is now a decision, not a surprise.** Per-student entitlement plus
  honor-system gating means a shared premium login is undetectable and unpreventable. Accepted.
  If it ever matters, the only lever is concurrent-session limits, which needs server-side
  session tracking that does not exist today.
- **Support load is the real price of charging** — not money, but evenings. State the response
  window in the parent group ("within 24 hours on weekdays, not at weekends"). Setting the
  expectation is free; not setting it is expensive.
- **Quiet launch.** Advertising a paid, education-adjacent service from an unfiled foreign host
  is the visible part of this. Telling existing families is not. Phase 1 is a quiet launch
  anyway.

---

## 8. Part E — Hosting: measure first, then choose

### 8.1 The problem is three problems

"Slow and laggy" has three independent causes, and only one is fixed by changing provider.

| # | What | Host | Symptom |
|---|---|---|---|
| 1 | Page + asset load | GitHub Pages | "Slow to open". GFW-throttled. Asset cache absorbs repeat visits; first visits and post-eviction visits hurt, and WeChat evicts aggressively. |
| 2 | API calls | Azure SWA Functions | Login and progress saves. Region unknown; `azurestaticapps.net` mainland reachability flagged unverified in Val's own notes. |
| 3 | Database | Cosmos DB `val-esl-db` | Region unknown. If not co-located with the Functions, every save pays an extra cross-continent hop. |

Cause 3 compounds cause 2: the save path is a read-modify-write with **up to four retries on
an `_etag` conflict**, so a slow round trip does not merely add latency, it multiplies.

### 8.2 Step 1 — confirm the Azure regions

**Via portal:** Azure Portal → Cosmos DB `val-esl-db` → Overview → *Location*. Then Static Web
Apps `brave-bush-0438ab000` → Overview → *Region*.

**Via CLI** (note: `az` is not on PATH on Val's machine — locate `az.bat` and call it by full
path):

```
az cosmosdb list -o table --query "[].{name:name, rg:resourceGroup, loc:location}"
az staticwebapp list -o table --query "[].{name:name, rg:resourceGroup, loc:location}"
```

If Cosmos is in a US or European region, **moving it to East Asia (Hong Kong) is a day's work
and may be most of the win** — with no origin change and no cache loss. Do that before
touching the frontend.

### 8.3 Step 2 — measure from real devices in Kunming

Build a small diagnostic page, `diag.html`, in the repo. It must not require login and must be
openable inside WeChat. It records, for a handful of targets (the API root, `version.json`,
one vocab image, one MP3):

- `PerformanceResourceTiming` phases — `domainLookupEnd`, `connectEnd`,
  `secureConnectionStart`, `responseStart`, `responseEnd` — which separate DNS from TCP from
  TLS from server time;
- a real `saveAnalytics` round trip with a synthetic event, timed;
- `navigator.connection.effectiveType`, `navigator.userAgent`, screen size, and whether the
  page is inside WeChat (`/MicroMessenger/i`);
- the current UTC time, so evening-peak samples are identifiable.

Results are **POSTed to the API and stored**, following the existing pattern — there is
already a `delivery_diag_saveAnalytics` telemetry document and existing analysis scripts
(`api/analyze_devices.js`, `api/analyze_speech.js`) to extend. Storing rather than displaying
means Val can send one link to the parent group and collect **crowd-sourced measurements from
the actual devices that matter**, not just his own.

**Sampling protocol:**

- Both **evening peak (20:00–22:00)** and off-peak, over **several days** — the complaint is
  specifically peak-hour degradation, and one sample proves nothing.
- On **mobile data and on WiFi** separately.
- **Inside WeChat and in a normal browser** separately.
- Confirm **no VPN** is active. This is the single easiest way to invalidate the whole exercise.
- Ideally a second family's device on a different ISP — GFW behaviour varies by ISP and province.

Deliverable: a short written summary answering *"where does the time actually go?"*

### 8.4 Step 3 — test the EdgeOne premise

The parked EdgeOne Pages project `classroom-survivors-preview` failed because the free
`*.edgeone.dev` domain returns **401 to mainland visitors by design**: serving the mainland
implies ICP filing, and Tencent will not sponsor an unfiled site on a shared subdomain.

The claim that a custom domain fixes this is a **hypothesis written before anyone bought a
domain — it has never been tested.** The reasoning is that with a mainland-excluded
acceleration region, mainland visitors are served from HK/Singapore nodes with no mainland
node involved, so filing should not apply. Sound reasoning. Still reasoning.

**Test procedure**, once a domain exists (§9):

1. Attach the custom domain to the EdgeOne Pages project.
2. Clear the three documented blockers first: `.mjs` served as `application/octet-stream`
   (needs an `edgeone.json` header override — this breaks module imports, so it is not
   cosmetic); CI-injected `app-config.json` is absent on this target; and the build must strip
   the >25MiB model files.
3. From a mainland device, **no VPN**, on mobile data: open the URL. Record HTTP status, TTFB,
   full load time, and whether the app actually boots.
4. `curl -I` the same URL from the same network and inspect EdgeOne's cache/edge headers to
   confirm which node answered.
5. Repeat inside WeChat's browser.
6. Repeat at evening peak.
7. Compare directly against `github.io` measured the same way, in the same session.

**Pass criterion:** mainland visitors get 200 and a materially better TTFB than GitHub Pages.
Anything else means EdgeOne is out and the choice is a CDN account or a VPS.

### 8.5 The origin-change trap

**A custom domain is an origin change, and an origin change wipes everything local.**
`localStorage` is origin-scoped. Moving from `vpietri-stack.github.io` to
`app.<domain>` loses:

- all cached profiles in `savedUsers` → **every student must log in again**;
- the pending analytics queue `csAnalyticsQueue_<id>` → **any unflushed progress is lost**;
- the entire IndexedDB asset cache → **re-download 35MB of vocab images plus a ~41MB Whisper
  model**, on GFW-throttled links, through WeChat's evicting cache.

Val previously **refused** a `vocab-v1`→`vocab-v2` cache-token bump specifically to avoid a
forced re-download storm. This is the same class of event, larger, and it must be chosen
deliberately rather than discovered.

**Mitigation — sequence so the pain happens once.** Attach the custom domain to **GitHub
Pages first**. GitHub Pages supports custom domains natively. Take the origin-change hit once,
while the app is still free and a rough week is survivable, at a quiet point in the term. The
immediate speed gain is small — it is still GitHub's infrastructure underneath — but the URL
is now decoupled from the host permanently, and **moving to EdgeOne later becomes a DNS
repoint with no origin change and no cache loss at all.**

Two things that will silently break if forgotten:

- **CORS.** `staticwebapp.config.json` currently allows exactly `https://vpietri-stack.github.io`.
  The new origin must be added, or every API call fails.
- **`config.js` derives `API_BASE_URL` from `location.hostname`** (lines 6–11). It must be
  updated for the new hostname — and see §8.6, because it should stop being hardcoded at all.

Also note: the `TD_ENABLED` / `THREE_TD_ENABLED` gates key off `location.pathname` containing
`/classroom-survivors-preview`, because both sites share a hostname. A custom domain changes
that assumption and **will alter which features are enabled**. These gates must be revisited
as part of the domain move, not after.

### 8.6 Make the API address remotely configurable

`API_BASE_URL` is compiled into the frontend bundle by hostname. If Azure ever goes dark from
the mainland, the app **cannot be repointed without shipping a new build to every client** —
through WeChat's cache, the worst possible delivery channel.

Add a small `bootstrap.json` on the static host containing the API base URL, fetched before
anything else, with the current hardcoded value as fallback. Then a host failure is a
seconds-long fix instead of a deploy-plus-cache-eviction problem. Cheap insurance, and exactly
the kind of thing to have in place *before* someone is paying.

This does not couple the two failures uselessly: the bootstrap file lives on the static host,
so it survives an API outage, which is the outage it is designed to mitigate.

### 8.7 Options, to be chosen on the evidence from §8.2–8.4

The hard constraint: **no ICP filing means no mainland nodes, ever.** The question is which
overseas edge has the best routes in.

| Option | Mainland routing | Cost | Ops burden | Notes |
|---|---|---|---|---|
| **EdgeOne Pages + custom domain** | Good (Tencent peering) | Free tier likely sufficient | None | Already configured. **Premise untested** (§8.4). "Global (MLC excluded)" = overseas nodes only; this is the ceiling, not a limitation to fix later. |
| **Aliyun / Tencent intl CDN, mainland-excluded** | Best available without filing | Pay-as-you-go, low | Low | Aliyun's *international* arm accepts a foreign passport for real-name verification — need not touch the Chinese entities at all. |
| **HK VPS on CN2 GIA / CMI** | Often beats any CDN without mainland nodes | ~$10–25/mo | **High** | One origin for static + API + DB: no CORS, no cross-origin token handling, one provider. Drops the SWA 250MB cap that forces the model-stripping hack. |
| **Cloudflare Pages** | **Poor** | Free | None | Non-enterprise traffic routes via US west coast. The China Network needs Enterprise + a Chinese partner + filing. **Rule out as primary.** |
| **Vercel / Netlify** | Poor | Free | None | `.vercel.app` frequently unreachable. **Rule out.** |

**On the VPS specifically — the honest cost is not the monthly fee.** It is that somebody must
be the sysadmin: patching, TLS renewal, backups, and noticing on a Saturday night that it is
down before Monday's classes. There is no SLA. The agent can write all of it — nginx config,
certificate automation, deploy scripts, backup jobs, a health check — but cannot be the person
who notices. This is the real trade and the reason it is not the default recommendation.

**On the API/database side:** a Static Web App's region is **fixed at creation and cannot be
changed**. Moving the Functions to Hong Kong therefore means either a new Static Web App in
East Asia, or lifting the API onto a standalone Functions App / App Service there. The second
is more work but drops the 250MB constraint and allows a proper custom domain on the API.
Cosmos migration is small — ~100 student documents plus archives — and `api/` already holds
several migration scripts to follow as a pattern.

### 8.8 Explicitly not now

Consolidating onto a single HK VPS with a non-Cosmos database. It is a rewrite of the deploy
pipeline and the data layer with no user-visible benefit at 100 families. Revisit when paying
users justify it.

### 8.9 Fallback that makes any of this safe

Keep GitHub Pages live throughout. Combined with §8.6, the whole app can be repointed in
seconds if a new host turns out to be worse than the old one.

---

## 9. Part F — Buying a domain (Val has no experience with this)

### 9.1 Where

Use a **foreign registrar**, paying by card (N26 works). Do **not** use Aliyun or Tencent as
registrar — it drags you into mainland hosting and filing workflows you are avoiding.

| Registrar | ~.com price/yr | Why |
|---|---|---|
| **Cloudflare Registrar** | ~$10 (at cost, no markup) | Cheapest long term, free WHOIS privacy. Requires a Cloudflare account and using Cloudflare nameservers. Slightly more setup. |
| **Porkbun** | ~$11 | Simplest UI, free WHOIS privacy, no upsell pressure. **Recommended for a first purchase.** |
| **Namecheap** | ~$11 first year, ~$16 renewal | Widely used, free WHOIS privacy year one. Watch the renewal price. |

Avoid GoDaddy-style registrars with aggressive upsells and paid privacy.

### 9.2 Which name

- **`.com` only.** Not `.cn` (real-name registration and filing pressure), not `.xyz`/`.top`
  (cheap first year, expensive renewal, and treated as spam-adjacent by some networks).
- Short, spellable over the phone in a WeChat voice message, no hyphens.
- **Not education-flavoured.** Consistent with the posture in §3: this is a tool, not a
  tutoring service. A neutral product name is both lower-risk and more flexible if the
  offering changes.
- Buy **one year** with **auto-renew on**. Multi-year prepay is not worth the lock-in.
- **Enable WHOIS privacy** (free at the three above). Val is a foreigner in China; his home
  address and phone would otherwise be in a public database.
- **Verify the registrant email.** ICANN requires it; an unverified contact gets the domain
  suspended, typically within 15 days. This is the single most common way a first-time buyer
  loses a domain they just paid for.

### 9.3 Why this is not a sunk cost

Every option in §8.7 needs a domain. If EdgeOne fails the §8.4 test, the same domain points at
a VPS. If a VPS is too much responsibility, it points at GitHub Pages. **The domain is the one
purchase that is correct under every branch.** ~¥70–100/year.

### 9.4 DNS notes

- Set an `A`/`CNAME` for the apex and for `api.` — putting the API on its own subdomain now
  means the API can move without touching the frontend's origin.
- Keep TTLs low (300s) during the migration period so a repoint takes effect quickly.
- Add the new origins to the CORS allowlist (§8.5) *before* switching.

---

## 10. Part G — End-of-session data loss

**This is a separate investigation with its own schedule, and it must not be folded into a
hosting migration.** A general speedup makes data loss *quieter* and makes it look fixed. It
is a prerequisite for charging, not a byproduct of moving servers.

### 10.1 Do not start from zero — the system is already instrumented

Reading the code changes the shape of this task. It is **not** "design instrumentation"; it is
"find out why existing instrumentation still loses data." Already present:

- **`csPageHeartbeat`** — a kill-surviving breadcrumb in `localStorage`, updated per queued
  event with a page-session id (`ps`), timestamp, load time, app version, and page state.
  Deliberately in `localStorage` because **a process kill runs no JS at all** — no `pagehide`,
  no flush — so the next page load has to interpret the corpse.
- **`csCleanUnload`** — set on graceful pagehide, so a missing marker means a kill.
- **`csBuildRestartDiagnostic`** — pure and unit-tested. A "hard kill" = breadcrumb younger
  than 1h + no clean-unload marker + no evidence the tail was delivered. Emits a
  `type:'device', diagnostic:'restart'` event on next login, invisible to dashboards and
  weekly targets.
- **`csLastBreathBeacon`** — fires on `pagehide`, `beforeunload` and
  `visibilitychange:hidden`, sending queue length, breadcrumb, build stamp and *which signal
  fired*. Explicitly documented in the code as **"NOT a fix for data loss — only makes the
  next loss self-describing."** Added after Doris's iPad+WeChat lost every post-login event
  because WKWebView killed the page between login and the 2s debounce flush.
- **Server-side acks already exist.** `saveAnalytics` returns `addedEventIds` and
  `duplicateEventIds`. The information needed to detect a gap is already crossing the wire and
  being discarded.
- **`delivery_diag_saveAnalytics`** — a server-side trace of the last accepted request
  (studentId, added, total, UA, transport), added after the 2026-08-28→09-03 "Doris iPad
  blackout" proved a client can receive ok-looking responses while nothing persists.
- **`test_session_flush_deadline.js`** already exists in the suite.

### 10.2 Step 1 — mine the data that already exists

**Cost: hours, not days. Do this before writing any new code.**

Extend the existing analysis-script pattern (`api/analyze_devices.js`) to query all `device`
events with `diagnostic: 'restart'` and `diagnostic: 'lastBreath'` across all students, and
read `delivery_diag_saveAnalytics`. Report:

- how often each fires, per app version, per UA, per device family;
- the `cause` distribution on lastBreath (`pagehide` vs `beforeunload` vs
  `visibilitychange:hidden`) — this alone says whether the browser is signalling death at all;
- `queueLenAtDeath` distribution — **a high value means events were buffered and never sent**;
- correlation between `restart` diagnostics and specific books/units/rounds, which would point
  at a code path rather than a device;
- whether losses cluster in **WeChat on iOS** specifically.

This may answer the question outright. It may also show the loss is rarer than it feels — or
concentrated in two or three families' devices.

### 10.3 Step 2 — widen the server-side ring

`delivery_diag_saveAnalytics` is deliberately a **single-slot** ring: last accepted request
only. That makes correlation impossible — you cannot reconstruct a timeline from one sample.
Change it to a **bounded ring (e.g. last 200 requests)** with the same fields. Additive,
best-effort, and must remain non-fatal to the save (the existing code is explicit that
diagnostics failures must never fail a save).

### 10.4 Step 3 — close the loop with client-side reconciliation

The client knows how many events it generated in a page-session (it has `ps`). The server
already acks exactly which event ids it stored. Nothing currently compares the two.

Add: the client records, per page-session, the ids it generated and the ids acked. On next
login, if there is a gap, emit `diagnostic: 'reconcile'` with counts and the missing ids.

This converts *"I think data was lost"* into *"page-session `ps_abc` generated 57 events,
server acked 41, missing 42–57"* — which is a debuggable statement. Reuse the existing
`type:'device'` + diagnostic-flag convention so it stays invisible to dashboards and weekly
targets, and let it ride the normal flush.

### 10.5 Step 4 — reproduce deterministically

Using the existing Playwright-core browser-test pattern (`test_handwriting_browser.js`,
`test_session_flush_deadline.js`), add a test that:

1. logs in a synthetic student, generates **N** known events;
2. kills the page at a **controlled point** — parameterised across: mid-debounce (inside the
   2s window), during the in-flight flush, after game-over before flush, and on
   `visibilitychange:hidden`;
3. reloads and logs in again;
4. asserts the server-side count for that page-session equals **N**.

Then repeat under **throttled network** (Playwright request interception with added latency,
or CDP throttling) to simulate Kunming evening-peak conditions deterministically rather than
waiting for them to occur.

**This is the only thing that distinguishes "fixed" from "quieter".** Without it, a hosting
migration will appear to fix the bug and will not.

### 10.6 Hypotheses to test explicitly

Ranked by how well they fit the existing evidence:

1. **The archive rollover is a read-side illusion.** Analytics roll into
   `student_analytics_archive` documents at ≥700 events. If a dashboard reads only the live
   document, events are not lost — they are **in the archive and not being shown**. This
   would be a read bug, not a write bug, and is the cheapest hypothesis to eliminate.
   `test_archive_merge_dashboard.js` exists, so this area has been touched before. **Check
   first.**
2. **WeChat clears `localStorage` under storage pressure.** The entire recovery strategy
   depends on the persisted queue `csAnalyticsQueue_<id>` surviving to the next launch. The
   codebase already documents that WeChat's WKWebView evicts HTTP cache aggressively; if it
   also evicts `localStorage`, the safety net has a hole in it. Testable directly on a device.
3. **The 2s debounce window.** A kill between the last event and the flush leaves everything
   to `pagehide`/`visibilitychange`. If WKWebView kills the process without firing either,
   only the breadcrumb survives — which is exactly the Doris failure that prompted
   `csLastBreathBeacon`. Step 1's `cause` distribution tells us whether this is still happening.
4. **A 200 response that persisted nothing** — the original Doris blackout. Suspect the `_etag`
   retry loop exhausting its four attempts, or an `upsert` failing silently. The widened ring
   from Step 2 is what makes this visible.
5. **Concurrent writers for the same student.** Two tabs or two devices for one login produce
   `_etag` conflicts on every write; four retries may not be enough under contention. Also
   relevant to the account-sharing decision in §7.4.
6. **`sendBeacon` body limits.** Beacons are silently dropped above a browser-specific size
   (~64KB in some WebKit versions). A long session's queue could exceed it. The code notes
   `text/plain` is the only reliably delivered content type, so this area has been considered —
   but the size ceiling should be verified against observed `queueLenAtDeath` values.

### 10.7 Definition of done

Not "no more reports from parents." Specifically:

- Step 1's report written, with a stated loss rate and device distribution.
- The archive-vs-write question (§10.6.1) answered definitively.
- A failing reproduction test exists, then passes.
- The test runs under throttled network as well as clean network.
- Reconciliation telemetry deployed, and **two weeks of clean reconcile data** before the first
  payment is taken.

---

## 11. Out of scope / phase 3

- **Which features are paid.** Blocked on §4.4 (core/extras split) and on the hosting evidence.
- **Stripe / Paddle.** Revisit for non-China buyers. Note the constraints: Alipay and WeChat
  Pay are both GA on Stripe but **recurring is private preview**, so no auto-renewal; WeChat
  Pay on Stripe has **no dispute process**; ~3.4% + fixed + FX to EUR is 4–6% all-in versus
  0.6% domestic; Stripe Checkout is a foreign domain and **Alipay redirects are blocked inside
  WeChat's webview**; and onboarding wants a residence or business in a supported country,
  which is an open question for a China-resident merchant.
- **A Chinese distributor as merchant of record.** The likely answer for the schools segment:
  it provides fapiao and moves the category-audit risk onto them.
- **企业微信 / 微信客服** as a parent-facing channel.
- **SMS OTP.** Feasible; blocked only on not collecting phone numbers (§6.5).
- **Consolidation onto one HK VPS** (§8.8).
- **Geo data deletion** — Val's, deliberately (§7.3).

---

## 12. Testing and verification

`npm test` currently runs **17 files** and must stay green; `test_deploy_stamp_sync.js` runs
first and fails the whole suite on version-stamp drift (**AGENTS.md Rule 1** — three stamps
must stay byte-identical: `version.json`, `APP_VERSION` in `frontend_auth.js`, and the `?v=`
in `index.html`).

New tests required:

| Area | Test |
|---|---|
| Entitlement | `grantDays` arithmetic: expired restarts from today; active extends; negative corrects; Asia/Shanghai day boundaries; the §4.2 worked example |
| Ledger | Append-only writes; goodwill grants record `amount: 0` |
| Passwords | Creation hashes; no plain text returned by `getStudents` with or without `includeSecure`; lazy migration converts on next login; login no longer overwrites a hash |
| Token caching | `savedUsers` contains no password; silent re-login works from a cached token alone |
| Recovery question | Normalization is **identical** at setup and verify — full-width, case, whitespace, punctuation, traditional/simplified; attempt lockout |
| Temp password | Single use; killed by a normal login; killed by regeneration; expires at 72h; forces `needsPasswordChange`; only checked after the real password fails |
| Consent | New registration requires it; existing student gets banner not block; policy version recorded |
| Deletion | Removes the student doc **and** its archives **and** activity-log references |
| Data loss | §10.5 — reproduction under clean and throttled network |
| Dashboard security | Extend `test_dashboard_security.js`: no password field in any response; premium controls require an admin token |

**Stage specific paths only — never `git add -A` (AGENTS.md Rule 2).** The repo carries a large
untracked `api/speech_events_dump_full.json` that must not be committed.

---

## 13. Documentation obligations

**AGENTS.md** requires that any agent changing code covered by a wiki page updates that page
**in the same commit**. This work touches at least:

- `docs/wiki/04-auth-versioning.md` — hashing, reset codes, temp passwords, `REQUIRE_AUTH` result
- `docs/wiki/10-backend-api.md` — new endpoints, ledger, consent, deletion
- `docs/wiki/11-data-model.md` — `premiumUntil`, `consent`, `recovery*`, `tempPassword*`, payments
- `docs/wiki/09-dashboards.md` — premium controls, coverage column, expiring-soon filter
- `docs/wiki/13-deployment.md` — new origin, EdgeOne, CORS, `bootstrap.json`
- `docs/wiki/15-gotchas-and-history.md` — index this spec and the data-loss findings

---

## 14. Suggested order of work

Sequenced so that nothing depends on an unverified premise, and so the risky origin change
happens once, deliberately, while the app is still free.

1. **§7.1** — confirm `REQUIRE_AUTH`. Five minutes. If it is off, nothing else matters.
2. **§10.2** — mine existing restart/lastBreath telemetry. Hours. May answer the data-loss
   question outright.
3. **§8.2** — confirm the Cosmos and Functions regions. Minutes.
4. **§4.4** — write the core/extras split. A product decision; blocks all gating work.
5. **§9** — buy the domain. ~¥100, needed by every hosting branch.
6. **§8.3** — build `diag.html`, sample from real devices at peak over several days.
7. **§8.4** — test EdgeOne against the mainland with the new domain.
8. **Parts A, B, C** — entitlement, ledger, dashboard controls, hashing, recovery question,
   temp passwords. Independent of the hosting outcome.
9. **§7.2** — privacy policy, consent capture, deletion path.
10. **§10.3–10.7** — close the data-loss investigation to its definition of done.
11. **§8.5–8.6** — the origin move and `bootstrap.json`, on the evidence, at a quiet point in
    the term.
12. **Launch quietly** to existing families (§7.4). Only then consider phase 3.

Steps 1–3 and 5 can all happen this week and cost under ¥200 between them.
