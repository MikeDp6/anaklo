# Στήσιμο τοπικά (Windows)

Στόχος: ένας νέος developer στήνει το project σε λιγότερο από 30 λεπτά.

## 1. Προαπαιτούμενα (μία φορά)

| Εργαλείο | Έκδοση | Σημείωση |
|---|---|---|
| Node.js | **24.15 ή νεότερη** (LTS 24.x) | Τη βλέπεις με `node -v`. Το jsdom των tests θέλει ≥ 24.15. |
| Git | πρόσφατη | `core.autocrlf=false`: τα line endings τα κρατά LF το `.gitattributes`. |
| Docker Desktop | πρόσφατη, με **WSL 2** | Χρειάζεται για το τοπικό Supabase (βάση, Auth, pgTAP). Πρέπει να τρέχει πριν το `npm run db:start`. |

Το project ζει στο `C:\Users\mixal\mnemo`: χωρίς ελληνικά στο path και εκτός OneDrive.

## 2. Πρώτη εγκατάσταση

```
npm install
copy .env.example .env.local
npx playwright install chromium webkit
npm run db:start
```

Αν αλλάξεις κάτι στα migrations ή στο `supabase/seed.sql`, το `npm run db:reset` ξαναχτίζει τη βάση.

Το `.env.example` έχει ήδη τις τοπικές τιμές του Supabase. Είναι δημόσιες, αφού αφορούν μόνο την τοπική βάση στο Docker.

Αν το `.env.local` σου είναι παλιότερο από το βήμα 1.5 (ή το 1.3), πρόσθεσε από το `.env.example` τις μεταβλητές που λείπουν (και μετά `npm run db:stop` και `npm run db:start`):

| Μεταβλητή (`.env.local`) | Τι είναι |
|---|---|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | Το τοπικό Supabase (δημόσια). |
| `PROXY_SECRET` | Κοινό μυστικό του `/api` proxy (Vite) και των Edge Functions (μέσω `[edge_runtime.secrets]` του `config.toml`). Τοπική τιμή, ≥ 16 χαρακτήρες. **Μετά από αλλαγή του: `npm run db:stop` και `npm run db:start`**, αλλιώς οι functions κρατούν την παλιά τιμή. |
| `APP_ENV=local` | Χαλαρώνει μόνο το cookie έμπιστης συσκευής (`td_<id>` χωρίς `Secure`, σε http://localhost). |
| `ANAKLO_ENV=local`, `SITE_HOST=localhost:5173`, `SMS_PROVIDER=fake`, `OTP_TEST_NUMBERS`, `OTP_TEST_CODE=424242`, `SMS_ALLOWED_RECIPIENTS=` | Οι functions `public-booking` και `manage` (1.3), μέσω `[edge_runtime.secrets]`. Τοπικές τιμές, όχι μυστικά. Χωρίς αυτές (ή με `ANAKLO_ENV` κενό = prod) απαντούν 500 `not_configured`. Ο ψεύτικος adapter δεν στέλνει τίποτα· με `ANAKLO_ENV=local` τυπώνει κάθε SMS (με κρυμμένο αριθμό) στα logs: `docker logs -f supabase_edge_runtime_anaklo`. |
| `PUSH_PROVIDER=fake`, `DISPATCH_SECRET=local-dev-only-dispatch-secret-not-a-secret-01` | Ειδοποιήσεις (1.5), μέσω `[edge_runtime.secrets]`, για τις `public-booking`, `manage` και `dispatch`. Τοπικές τιμές, όχι μυστικά. Ο ψεύτικος αποστολέας push φτιάχνει το ακριβές payload του OneSignal και δεν στέλνει τίποτα (η γραμμή του `messages_log` γίνεται `sent` με provider `fake`). Το `DISPATCH_SECRET` πρέπει να είναι ίδιο με το `dispatch_secret` που γράφει το `seed.sql` στο Vault: με αυτό η βάση (pg_net) καλεί την `dispatch`. Χωρίς αυτές οι τρεις functions απαντούν 500 `not_configured`. |
| `VITE_ONESIGNAL_APP_ID` | Κενό (τοπικά μέχρι το 1.10): η οθόνη Ρυθμίσεις → Ειδοποιήσεις λέει ότι οι ειδοποιήσεις δεν είναι διαθέσιμες ακόμη. Τοπικό app του OneSignal μόνο αν δοκιμάζεις push τοπικά. |
| `SUPABASE_DEV_PROJECT_REF`, `SUPABASE_DEV_PUBLISHABLE_KEY` | Το remote dev project (δημόσια). Τα χρειάζονται τα `*:dev`. |

Κλειδιά και tokens (`SUPABASE_SECRET_KEY`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, το remote `PROXY_SECRET`, `ONESIGNAL_*`) **δεν** μπαίνουν ποτέ στο `.env.local` ή στο repo: βλ. §4.

## 3. Καθημερινή δουλειά

| Εντολή | Τι κάνει |
|---|---|
| `npm run dev` | Dev server στο http://localhost:5173 |
| `npm run typecheck` | Έλεγχος τύπων TypeScript |
| `npm run lint` | ESLint |
| `npm test` | Vitest (τρέχει πάντα σε UTC, όποια ώρα κι αν έχει ο υπολογιστής) |
| `npm run db:test` | pgTAP: RLS, δικαιώματα, διπλοκράτηση, events κ.λπ. |
| `npm run test:race` | Ταυτόχρονες κρατήσεις μέσω HTTP στο τοπικό Supabase (20 στην ίδια ώρα → 1 ραντεβού· 10 επαναλήψεις μιας online κράτησης με ίδιο κλειδί → 1 ραντεβού, ένα grant → μία κράτηση· από το 1.4 μετακίνηση από την εφαρμογή και κράτηση στην ίδια ώρα → πετυχαίνει μία, και όταν η μετακίνηση δίνει το ραντεβού σε συνάδελφο· 10 ίδιες μετακινήσεις με ένα κλειδί → μία· από το 1.5 δύο dispatchers ταυτόχρονα → κάθε μήνυμα το πολύ μία φορά, και dispatcher που «πεθαίνει» στη μέση της παρτίδας → τίποτα διπλό· από το 1.6 δύο `mark_absence` μαζί → μία άδεια, δύο `replace_week_hours` μαζί → ακριβώς η μία από τις δύο εβδομάδες, σε δικό του συνθετικό μαγαζί `race-schedule` που στήνει τοπικά το ίδιο το test). Θέλει `db:start`· μην το τρέχεις μαζί με το `e2e` (συνδέουν τον ίδιο owner· το e2e προκαλεί και αποστολές). |
| `npm run e2e` | Playwright σε μέγεθος κινητού (Chrome + WebKit). Θέλει να τρέχει το `db:start`. Από το βήμα 1.1 θέλει και `PROXY_SECRET` και `APP_ENV=local` στο `.env.local`. Κάθε online κράτηση ενός test ακυρώνεται στο τέλος του (μέσω του link διαχείρισης), ώστε οι επαναλήψεις να βρίσκουν τις ίδιες ελεύθερες ώρες· τα ραντεβού των tests της εφαρμογής επαγγελματία μένουν σε δικές τους μέρες, 2–5 εβδομάδες μπροστά (`npm run db:reset` τα καθαρίζει). Το test «δεύτερη συσκευή» περιμένει το refetch των 60″ (~70″). Από το 1.6 τα specs ρυθμίσεων και έκτακτης απουσίας στήνουν τοπικά (με τον κώδικα του provisioning, `e2e/lib/shops.ts`) δικά τους συνθετικά μαγαζιά ανά browser (`e2e-settings-*`, `e2e-absence-*`) και το `demo-provision` του παραδείγματος, ώστε να μην αγγίζουν τις ώρες του `demo-barber`· η έκτακτη απουσία παραλείπεται όταν μένουν < 2 ώρες ως τα μεσάνυχτα (ώρα Ελλάδας). |
| `npm run build`, μετά `npm run size` | Build και έλεγχος ότι η σελίδα κράτησης μένει ≤ 120 KB gzip |
| `npm run gen:types` | Ξαναφτιάχνει το `src/shared/lib/database.types.ts` από την τοπική βάση. Τρέξ' το μετά από κάθε αλλαγή σχήματος: το CI ελέγχει με το `check:types` ότι είναι ενημερωμένο. |
| `npm run fn:check` | `deno check` + `deno lint` στις Edge Functions (`supabase/functions`), με το deno του `node_modules`. Αποτυγχάνει και αν μια function δεν έχει `[functions.<name>]` με ρητό `verify_jwt` στο `config.toml`. Τρέχει στο CI. |
| `npm run fn:serve` | Σερβίρει τις functions με όλο το `.env.local` ως env (π.χ. για `ONESIGNAL_*` τοπικά). Θέλει να τρέχει το `db:start`, που **ήδη** σερβίρει τις functions με το `PROXY_SECRET`: για τα συνηθισμένα δεν χρειάζεται. |
| `npm run edge:dev` | Ο Cloudflare Worker τοπικά (wrangler, http://localhost:8787) πάνω στο `dist/` και στο τοπικό Supabase. Πριν: `npm run build` και μία φορά `copy edge\.dev.vars.example edge\.dev.vars` (gitignored· το `PROXY_SECRET` ίδιο με του `.env.local`). Για καθημερινή δουλειά αρκεί το `npm run dev`, που περνά από τα ίδια modules. |
| `npm run provision:local` | Τρέχει το provisioning με το συνθετικό `supabase/provision/demo-barber.example.json` στην τοπική βάση (φτιάχνει το `demo-provision`). Ξανατρέχει χωρίς αλλαγές. Το `db:reset` το σβήνει. |
| `npm run gen:icons` | Ξαναφτιάχνει τα PNG εικονίδια της PWA στο `public/app/`. |

Για να δεις την εφαρμογή:
- http://localhost:5173/demo-barber: σελίδα κράτησης της φανταστικής επιχείρησης του seed (και http://localhost:5173/r/demo01, το σύντομο link των SMS). Δοκιμαστικά κινητά με κωδικό `424242`: `6900000001` (Γιώργος Π. και Μάριος Π., κοινό κινητό), `6900000002`, `6900000999` (χωρίς πελάτη). Για άλλο κινητό ο κωδικός φαίνεται στα logs του ψεύτικου adapter (παραπάνω). Το link διαχείρισης `/m/<token>` της επιβεβαίωσης ακυρώνει ή μετακινεί.
- http://localhost:5173/app: εφαρμογή επαγγελματία. Σύνδεση με email του seed (`owner@demo-barber.test`, `manager@demo-barber.test`, `alex@demo-barber.test`· το `nomember@demo-barber.test` δείχνει «χωρίς πρόσβαση»). Ο κωδικός 6 ψηφίων φτάνει στο Mailpit.
- http://127.0.0.1:54324: Mailpit (τα emails του τοπικού Auth)
- http://127.0.0.1:54323: Supabase Studio (τοπικό)
- Στο iPhone Simulator/Safari η `/app` ζητά πρώτα «Πρόσθεσε στην αρχική οθόνη»· στον desktop browser όχι.

Αυτόματη ολοκλήρωση (1.4): το pg_cron τρέχει το job `auto-complete` κάθε 10′ και στην τοπική βάση (ολοκληρώνει τα ραντεβού που τελείωσαν πριν από `auto_complete_after_min`). Κάθε εκτέλεση γράφει μια γραμμή στο `private.job_runs`: `docker exec supabase_db_anaklo psql -U postgres -c "select * from private.job_runs order by id desc limit 5"`.

Ειδοποιήσεις (1.5): τα SMS και τα push στέλνονται από το `messages_log`. Όσα προκαλεί ο πελάτης (OTP, επιβεβαίωση, ακύρωση/αλλαγή από το link) τα στέλνουν αμέσως οι `public-booking`/`manage`· όσα προκαλεί η εφαρμογή επαγγελματία (π.χ. ακύρωση με «Ενημέρωση με SMS», δοκιμαστική ειδοποίηση) τα στέλνει η Edge Function `dispatch`, που την καλεί η ίδια η βάση μέσω pg_net στο `http://kong:8000/functions/v1/dispatch` αμέσως μετά το commit. Το job `dispatch-sweep` (κάθε 5′) την ξανακαλεί για τις υπενθυμίσεις και ό,τι έμεινε, και το `nightly-purge` (01:17 UTC) καθαρίζει τα παλιά. Όλα φαίνονται στο `messages_log` (`docker exec supabase_db_anaklo psql -U postgres -c "select template, channel, status, error, scheduled_for from public.messages_log order by created_at desc limit 10"`), τα κείμενα των SMS και οι γραμμές `fake-push` στο `docker logs -f supabase_edge_runtime_anaklo`, και οι εκτελέσεις του dispatch στο `private.job_runs` (`job = 'dispatch'`). Αν δεν στέλνει τίποτα: έλεγξε ότι το `DISPATCH_SECRET` του `.env.local` είναι ίδιο με του `seed.sql` και ξαναξεκίνα το stack (`db:stop`/`db:start`).

Μετά από αλλαγή στο `supabase/config.toml`, στο `supabase/templates/` ή στο `PROXY_SECRET`: `npm run db:stop` και `npm run db:start` (το `db:reset` δεν αρκεί). Περίμενε λίγα δευτερόλεπτα πριν ζητήσεις κωδικό: τα πρώτα emails μετά την εκκίνηση μπορεί να βγουν με το προεπιλεγμένο πρότυπο.

Πριν πεις ότι κάτι τελείωσε: `typecheck`, `lint`, `test`, και αν άλλαξε η βάση `db:reset` + `db:test`. Αν άλλαξαν Edge Functions: `fn:check`.

## 4. Βάση: migrations (ADR-0004)

- Αλλαγές σχήματος γίνονται **μόνο** με αρχεία στο `supabase/migrations/` και το Supabase CLI. **Ποτέ** από τον SQL editor.
- Κάθε νέος πίνακας έρχεται με RLS, πολιτικές και ρητά GRANT στο ίδιο αρχείο. Όταν προσθέτεις πίνακα ή RPC, ενημερώνεις και τις λίστες στο `supabase/tests/01_security.test.sql`.
- Τοπικά: `npm run db:reset` και μετά `npm run db:test`.

### Remote dev project (Supabase `anaklo-dev`, EU/eu-west-1)

Μία φορά:
```
npx supabase login
npx supabase link --project-ref <DEV_REF>
```
Βάλε το `<DEV_REF>` και στο `.env.local` ως `SUPABASE_DEV_PROJECT_REF`.

| Περίπτωση | Εντολή |
|---|---|
| Νέο migration | `npm run db:push` (+ `npm run db:test:dev`· προαιρετικό πριν το 1.10). Από το 1.10: → `npm run secrets:dev` → `npm run db:test:dev` → `npm run deploy:dev` |
| Άλλαξε migration που έχει ήδη σταλεί (επιτρέπεται μόνο πριν μπουν πραγματικά δεδομένα) | `npm run db:reset:dev` → `npm run secrets:dev` → `npm run provision:dev` → `npm run db:test:dev` → `npm run deploy:dev` (τα secrets/provision/deploy τρέχουν από το βήμα 1.10). Μετά από κάθε remote reset: πραγματικά όρια στο `private.platform_settings` (το `seed.sql` τα χαλαρώνει για τα τοπικά e2e· στο dev `sms_daily_cap = 30`) |
| Έλεγχος ότι το dev στήθηκε σωστά (pgTAP στο remote, όλα γίνονται rollback) | `npm run db:test:dev` |

**Deploy, μυστικά, provisioning (τα scripts υπάρχουν από το 1.1· τρέχουν στο 1.10, C7).** Όλα αρνούνται project άλλο από το `SUPABASE_DEV_PROJECT_REF` και άγνωστα ορίσματα. Τα κλειδιά ζουν σε αρχείο **εκτός repo**, π.χ. `C:\Users\mixal\anaklo-private\dev.env`, και περνούν με `--env-file`:

```
SUPABASE_ACCESS_TOKEN=…      # CLI (αντί για supabase login)
SUPABASE_DB_PASSWORD=…       # db push
CLOUDFLARE_API_TOKEN=…       # wrangler (πρότυπο «Edit Cloudflare Workers»)
CLOUDFLARE_ACCOUNT_ID=…
PROXY_SECRET=…               # ≥ 32 χαρακτήρες, διαφορετικό από το τοπικό· ίδιο σε Worker και functions
ONESIGNAL_APP_ID=…           # προαιρετικό ζεύγος, για το spike-push (αργότερα το dispatch)
ONESIGNAL_REST_API_KEY=…
OTP_HMAC_KEY=…               # υποχρεωτικό από το 1.3: Vault otp_hmac_key (≥ 32 χαρακτήρες base64/hex)· όχι η τιμή του seed.sql
PHONE_HMAC_KEY=…             # υποχρεωτικό από το 1.3: Vault phone_hmac_key (private.phone_hmac())· ΠΟΤΕ δεν αλλάζει μετά
PUSH_PROVIDER=fake           # υποχρεωτικό από το 1.5: fake ή onesignal (το onesignal θέλει και τα δύο ONESIGNAL_*)
DISPATCH_SECRET=…            # υποχρεωτικό από το 1.5: ≥ 32 χαρακτήρες, όχι η τιμή του seed.sql· functions + Vault dispatch_secret
DISPATCH_URL=https://<DEV_REF>.supabase.co/functions/v1/dispatch   # υποχρεωτικό από το 1.5: Vault dispatch_url, ακριβώς αυτό
VITE_ONESIGNAL_APP_ID=…      # το ίδιο app id, για το build του dev (δημόσιο)
SUPABASE_SECRET_KEY=…        # μόνο για provision:dev
```

| Εντολή | Τι κάνει |
|---|---|
| `npm run secrets:dev -- --env-file <αρχείο>` | `PROXY_SECRET`, `PUSH_PROVIDER`, `DISPATCH_SECRET` (+ `ONESIGNAL_*`) στις functions (`supabase secrets set`), `PROXY_SECRET` και `SUPABASE_PUBLISHABLE_KEY` στον Worker (`wrangler secret put`), `OTP_HMAC_KEY`/`PHONE_HMAC_KEY`/`DISPATCH_SECRET`/`DISPATCH_URL` στο Vault (`otp_hmac_key`, `phone_hmac_key`, `dispatch_secret`, `dispatch_url`: ένα `DO` με create ή update ανά όνομα μέσω `supabase db query --linked`· θέλει `supabase link` στο dev, αλλιώς αρνείται πριν γράψει οτιδήποτε). Το ίδιο `DISPATCH_SECRET` πάει στην `dispatch` και στο Vault (με αυτό η βάση καλεί την `dispatch` μέσω pg_net). Idempotent· `--dry-run` δείχνει μόνο ονόματα. Αν ο Worker δεν υπάρχει ακόμη και αποτύχει, τρέξε πρώτα `deploy:dev`. |
| `npm run deploy:dev -- --env-file <αρχείο>` | `db push` → `fn:deploy:dev` → build με το URL/κλειδί του dev → σβήσιμο `dist/**/*.map` → `wrangler deploy`. Idempotent· `--yes` χωρίς ερώτηση, `--dry-run` μόνο σχέδιο. Δεν αγγίζει ποτέ ρυθμίσεις Auth. Έλεγχος μετά: `https://<worker>/api/functions/v1/health` → 200. |
| `npm run fn:deploy:dev` | Μόνο οι Edge Functions (`--use-api` αν δεν τρέχει Docker). Δεν σβήνει functions που αφαιρέθηκαν από το repo: αυτές (π.χ. `spike-td`, `spike-push`, και το `push-identity` αν είχε σταλεί) σβήνονται με το χέρι, όπως και ένα secret που δεν χρησιμοποιείται πια (π.χ. `ONESIGNAL_IDENTITY_KEY`). |
| `npm run provision:dev -- --file <json εκτός repo> --env-file <αρχείο>` | Επιχείρηση, προσωπικό, υπηρεσίες, ωράρια, μέλη (χρήστες Auth χωρίς link). Προεπιλογή αρχείου: `C:\Users\mixal\anaklo-private\provision.json`· `--validate` ελέγχει μόνο το JSON. Δείγμα: `supabase/provision/demo-barber.example.json` (από το 1.6 και `business.address`, `business.maps_url`, `policy.quiet_start`/`quiet_end` και `policy.reminder_mode`· όσα πεδία λείπουν από το αρχείο μένουν όπως είναι). |

Worker: στο `edge/wrangler.jsonc` το `vars.SUPABASE_URL` πρέπει να δείχνει στο dev project (το ελέγχουν `deploy:dev` και `secrets:dev`). Το `routes` για το `dev.anaklo.gr` ενεργοποιείται όταν η ζώνη `anaklo.gr` μπει στο Cloudflare.

Το `db:reset:dev` ξαναχτίζει τη remote dev βάση από το μηδέν. Αρνείται να τρέξει αν το συνδεδεμένο project δεν είναι το dev. Σβήνει και τα δεδομένα του provisioning (επιχείρηση demo, μέλη) και ίσως τα μυστικά του Vault, γι' αυτό (από το 1.10) ακολουθούν `secrets:dev` και `provision:dev`, και μετά `db:test:dev` και `deploy:dev`. Το `seed.sql` τρέχει και στο remote reset: γράφει τα τοπικά κλειδιά του Vault μόνο αν λείπουν (το `secrets:dev` τα αντικαθιστά) και χαλαρώνει τα όρια του `platform_settings`, που πρέπει να ξαναμπούν.

Οι functions `public-booking` και `manage` θέλουν στο remote (1.10) και `ANAKLO_ENV=dev`, `SITE_HOST=dev.anaklo.gr`, τον πραγματικό πάροχο SMS και `SMS_ALLOWED_RECIPIENTS` (contract 1.3 §9)· μέχρι τότε απαντούν 500 `not_configured`, σκόπιμα.

**Auth στο dashboard (ανά project, με το χέρι, ADR-0009 §7).** Το `config.toml` ισχύει μόνο τοπικά. **Ποτέ** `supabase config push`: θα έστελνε στο remote τις τοπικές διευθύνσεις (`site_url` κ.λπ.) και το τοπικό όριο emails. Σε κάθε project, στο Authentication:

- «Allow new users to sign up» = **off** (Sign In / Providers)
- MFA: **TOTP** enroll και verify ενεργά. Χωρίς αυτό η εγγραφή της εφαρμογής κωδικών (1.7) αποτυγχάνει στο remote.
- Email OTP: μήκος **6**, λήξη **600 s**
- Site URL `https://dev.anaklo.gr/app/`· redirect URLs `https://dev.anaklo.gr/app/**` και `http://localhost:5173/app/` (στο prod τα αντίστοιχα του `anaklo.gr`, χωρίς localhost)
- Custom SMTP = Resend (`smtp.resend.com`, θύρα 465, αποστολέας στο `mail.anaklo.gr`, περιοχή EU)
- Πρότυπο «Magic Link» → το πρότυπο κωδικού από το `supabase/templates/` (`{{ .Token }}`, χωρίς link, στατικό δίγλωσσο)
- Όριο emails του Auth: π.χ. **30 την ώρα**
- Συνεδρίες: διάρκεια access token (JWT) **3600 s** και refresh token rotation ενεργό (προεπιλογές, μόνο επιβεβαίωση)
- **prod (Supabase Pro):** «Inactivity timeout» = **720h** (30 ημέρες αδράνειας) και «Time-box user sessions» κενό (κανένα απόλυτο όριο). Στο Free (`anaklo-dev`) οι ρυθμίσεις δεν υπάρχουν· το όριο αδράνειας το επιβάλλει και η εφαρμογή (ADR-0009).

**OneSignal (δοκιμή push του 1.10, ADR-0010 §3).** Ένα app ανά origin (`https://dev.anaklo.gr`)· ρύθμιση «Custom Code», με auto-prompt και slidedown **κλειστά** (η άδεια ζητείται μόνο με πάτημα κουμπιού)· service worker `app/sw.js`, scope `/app/`. **Identity Verification κλειστό, πάντα** (ADR-0010 §2): υποστηρίζει μόνο τα mobile SDKs, και σε app με Web SDK σπάει τα `login`/`addEmail`/`addSms` του web. Η εφαρμογή δεν δηλώνει ποτέ ταυτότητα στο OneSignal (κανένα `login`, κανένα `external_id`)· τα push στέλνονται μόνο με `include_subscription_ids`, και ποια συνδρομή ανήκει σε ποιον το αποφασίζει ο server. Στο dashboard οι συνδρομές φαίνονται ανώνυμες, και έτσι πρέπει. Για τα βήματα της δοκιμής με κλειστή εφαρμογή, το push στέλνεται από το dashboard ως δοκιμαστικό μήνυμα στη συνδρομή της συσκευής (ADR-0010 §3). Το SDK φορτώνει από `cdn.onesignal.com`: αν ο Worker αποκτήσει CSP, επίτρεψε `cdn.onesignal.com` (scripts) και `onesignal.com` (connect). App id → `VITE_ONESIGNAL_APP_ID` + `ONESIGNAL_APP_ID`, REST key → `ONESIGNAL_REST_API_KEY` (μόνο στο αρχείο εκτός repo).

## 5. Συχνά προβλήματα

| Πρόβλημα | Λύση |
|---|---|
| `db:start` αποτυγχάνει | Άνοιξε το Docker Desktop και περίμενε να γράψει «Engine running». |
| Το `database.types.ts` βγήκε «σπασμένο» | Μην τρέχεις `supabase gen types … > αρχείο` στο PowerShell (γράφει UTF-16). Χρησιμοποίησε το `npm run gen:types`. |
| Η σελίδα κράτησης γράφει «Δεν φόρτωσε η σελίδα» | Το τοπικό Supabase δεν τρέχει (`npm run db:status`) ή λείπει το `.env.local`. |
| `EBADENGINE` στο `npm install` | Αναβάθμισε το Node σε 24.15+. |
| `/api/functions/v1/*` δίνει 500 `proxy_not_configured` ή 403 | Το `PROXY_SECRET` λείπει από το `.env.local`, είναι < 16 χαρακτήρες ή άλλαξε χωρίς επανεκκίνηση: `npm run db:stop` και `npm run db:start`. |
| Μετά το 1.5 η κράτηση ή το link διαχείρισης δίνει 500 `not_configured`, ή η `dispatch` 404 «Function not found» | Λείπουν `PUSH_PROVIDER`/`DISPATCH_SECRET` από το `.env.local` ή το stack δεν ξαναξεκίνησε: πρόσθεσέ τα από το `.env.example` και `npm run db:stop` → `npm run db:start` → `npm run db:reset`. |
| Δεν φτάνει κωδικός στο Mailpit | Το email δεν ανήκει σε χρήστη (κλειστό signup: σωστά δεν στέλνεται τίποτα) ή ζήτησες δεύτερο κωδικό μέσα σε 1 s. |
