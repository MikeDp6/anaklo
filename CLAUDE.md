# CLAUDE.md — Anaklo

Οδηγίες για το Claude Code σε αυτό το repo. Διάβασέ τες σε κάθε συνεδρία.

## Τι είναι το project
**Anaklo** (Nous Operations): πλατφόρμα ραντεβού + έξυπνου πελατολογίου για κουρεία, κομμωτήρια, κέντρα αισθητικής.
Booking → Memory → Retention. Πρώτος κλάδος: **κουρεία**. Πιλότος: με την πρώτη επιχείρηση που θα βρεθεί (Φάση 4).

**Πηγή αλήθειας:** `docs/SPEC.md` (v0.4) και οι αποφάσεις στο `docs/adr/`. Αν κάτι εδώ ή στον κώδικα συγκρούεται με το SPEC, ρώτα πριν αλλάξεις κατεύθυνση.

## Γλώσσα
- Επικοινωνία με τον χρήστη (Μιχάλης): **ελληνικά**, σύντομα και πρακτικά.
- Κώδικας, ονόματα αρχείων/μεταβλητών, commits: **αγγλικά**.
- Κείμενα UI: **μόνο μέσω i18n** (`src/shared/i18n/{el,en}/<namespace>.json`, `el` default).

## Stack
- Vite 8 + React 19 + **TypeScript 6 strict** · TanStack Query v5 · React Hook Form + **Zod 4 μόνο `zod/mini`** · date-fns v4 + `@date-fns/tz` · i18next
- React Router v8 (data mode) **μόνο στην εφαρμογή επαγγελματία**. Η σελίδα κράτησης δεν έχει router (`src/app/booking/route.ts`).
- Styling: **CSS variables (design tokens) + CSS modules**. ΟΧΙ Tailwind. Γραμματοσειρές self-hosted από npm: Manrope (`@fontsource-variable/manrope`) και GFS Didot για τίτλους (`@fontsource/gfs-didot`, μόνο `greek` + `latin` 400).
- Supabase (Postgres + RLS, Auth μόνο για προσωπικό, Storage, Realtime, Edge Functions, pg_cron), **EU** (dev: `anaklo-dev`, eu-west-1 Ιρλανδία), ξεχωριστό project. Ποτέ άλλο project του λογαριασμού.
- Διαθεσιμότητα και κράτηση: **SQL functions** (ADR-0003). Edge Functions μόνο για παρενέργειες (OTP, SMS, push, email).
- Push **μόνο προσωπικού** (ADR-0010, proposed): OneSignal αν περάσει η δοκιμή του 1.10 σε PWA εγκατεστημένη στην αρχική οθόνη iPhone, αλλιώς Web Push (VAPID). **Καμία ταυτότητα στον client** (ποτέ `OneSignal.login`/`external_id`, ποτέ Identity Verification στο web app): αποστολή μόνο με `include_subscription_ids` (`_shared/onesignal.ts`), και ποια συνδρομή ανήκει σε ποιον το αποφασίζει ο server (`push_subscriptions` από το 1.5). Πάροχος SMS (επιλογή στη Φάση 1, κριτήρια SPEC §18), Resend (email, EU), Sentry (EU).
- Hosting: **Cloudflare Workers**: static assets + **ένας** Worker (`edge/`, από το 1.1) για σελίδα κράτησης, `/app`, `/<slug>` (Open Graph) και σκληρυμένο `/api` proxy που κατέχει το cookie της έμπιστης συσκευής (ADR-0008). Domains `anaklo.gr` / `dev.anaklo.gr` (από το 1.10).
- Σύνδεση προσωπικού (ADR-0009): κωδικός email 6 ψηφίων, signup κλειστό. Owner/manager: κωδικός email + εφαρμογή κωδικών (TOTP, από το 1.7) σε κάθε νέα σύνδεση, υποχρεωτική πρόταση 2ης συσκευής, επαναφορά μόνο από τη Nous (runbook `mfa-reset.md`), συνεδρία λήγει μετά από 30 ημέρες αδράνειας («Inactivity timeout» 720h στο prod και φύλακας στην εφαρμογή, γιατί το Free δεν το έχει)· staff μόνο κωδικός email, ποτέ TOTP· στο UI ποτέ «TOTP/MFA/2FA» (Vitest στις τιμές i18n).
- Συνεδρίες και ρόλοι (ADR-0009): αποσύνδεση `signOut({ scope: 'local' })` + `OneSignal.User.PushSubscription.optOut()` (κοινά κινητά· από το 1.5 και `unregister_push_subscription`)· «Αποσύνδεση από όλες τις συσκευές» (`global`) στις Ρυθμίσεις → Ασφάλεια. Ο ρόλος διαβάζεται πάντα από το `business_members`, ποτέ από το JWT. `set_member_role`/`remove_member` (owner με φρέσκο κωδικό, `audit_log`) ανακαλούν τις συνεδρίες του χρήστη στην ίδια συναλλαγή· όταν ο υψηλότερος ρόλος του πέφτει σε staff ή σε κανέναν, σβήνουν και τους παράγοντές του. Αυτές οι συνέπειες ζουν στο trigger `business_members_access_changed` (0009), που ισχύει και για το provisioning· ποτέ κώδικας που το παρακάμπτει. Owner/manager με επαληθευμένο παράγοντα μετρούν στο RLS και στις RPCs μόνο σε `aal2` (`private.session_mfa_ok()` στις βοηθητικές functions συμμετοχής, D2 του contract 1.7). Ο έλεγχος φρέσκου κωδικού γίνεται μόνο μέσα στο `_impl` (`42501`, hint `aal2_required` ή `fresh_totp_required`)· μόνο αυτά τα δύο hints ανοίγουν το `StepUpSheet` (μία επανάληψη της κλήσης). Συσκευές κωδικών: αφαίρεση μόνο μέσω Edge Function `manage-factors`, προσθήκη μόνο μετά από `authorize_factor_change`· ποτέ `mfa.unenroll` για επαληθευμένο παράγοντα.
- **Χωρίς Realtime στη Φάση 1:** refetch on focus και κάθε 60″, μαζί με push.
- Πλάνο Φάσης 1: `docs/plans/phase-1.md` (βήματα 1.1–1.10). **Τοπικά πρώτα:** μέχρι το 1.10 μόνο localhost, με ψεύτικο adapter SMS και δοκιμαστικούς αριθμούς· domain, deploy, λογαριασμοί, πραγματικός πάροχος SMS και δοκιμές σε συσκευές στο 1.10.
- PWA πρώτα. Native (Capacitor) μόνο αν αποφασιστεί ρητά.

## Εντολές
```
npm install
npm run dev          # dev server
npm run build
npm run typecheck    # tsc --noEmit
npm run lint
npm run test         # vitest (τρέχει πάντα σε UTC)
npm run e2e          # playwright (θέλει db:start)
npm run size         # μετά το build: σελίδα κράτησης ≤ 120KB gzip
npm run check:secrets # τρέχει αυτόματα μετά το build: κανένα server κλειδί στο frontend
npm run db:start     # τοπικό Supabase (Docker)
npm run db:reset     # migrations + seed στην τοπική βάση
npm run db:test      # pgTAP
npm run test:race    # ταυτόχρονες κρατήσεις μέσω HTTP στο τοπικό Supabase (θέλει db:start· όχι μαζί με e2e)
npm run db:push      # ΝΕΑ migrations στο συνδεδεμένο (remote) project
npm run db:reset:dev # ξαναχτίζει τη remote DEV βάση (μόνο πριν τα πραγματικά δεδομένα)
npm run db:test:dev  # pgTAP πάνω στη remote DEV βάση (rollback, δεν αφήνει δεδομένα)
npm run gen:types    # τύποι βάσης → src/shared/lib/database.types.ts (μετά από κάθε αλλαγή σχήματος)
npm run check:types  # αποτυγχάνει αν οι τύποι δεν ταιριάζουν με την τοπική βάση (τρέχει στο CI)
npm run fn:check     # deno check + deno lint στις Edge Functions (τρέχει στο CI)
npm run fn:serve     # functions με επιπλέον env από .env.local (το db:start ήδη τις σερβίρει)
npm run edge:dev     # ο Worker τοπικά (wrangler), μετά από build· θέλει edge/.dev.vars
npm run provision:local # provisioning του συνθετικού example στην τοπική βάση
npm run gen:icons    # εικονίδια PWA (public/app/*.png)
npm run fn:deploy:dev # Edge Functions στο remote DEV (μέρος του deploy:dev)
npm run deploy:dev   # migrations → functions → build → σβήσιμο .map → Worker (μόνο DEV)
npm run secrets:dev  # μυστικά functions + Worker από --env-file ΕΚΤΟΣ repo
npm run provision:dev # επιχείρηση από JSON ΕΚΤΟΣ repo στο remote DEV
npm run mfa-reset -- --local --email … --reason "…" --ticket …  # επαναφορά συσκευών κωδικών (runbook mfa-reset.md)· χωρίς --yes μόνο ξηρή εκτέλεση
```
Τα `*:dev` και το `db:push` αγγίζουν remote project: τα τρέχει μόνο ο χρήστης, ποτέ ο agent (ούτε με `--help`). Το ίδιο το `mfa-reset` (και το `scripts/provision-business.mjs`) **χωρίς `--local`**: η προεπιλογή του είναι το remote DEV· ο agent το τρέχει μόνο με `--local`. Τα δικά μας scripts (`scripts/*.mjs`) αρνούνται άγνωστα ορίσματα πριν κάνουν οτιδήποτε.
Χρησιμοποίησε πάντα τα npm scripts (όχι `>` στο PowerShell: γράφει UTF-16).
**Πριν πεις ότι κάτι τελείωσε:** τρέξε `typecheck`, `lint`, `test` και, αν άλλαξε η βάση, `db:reset` + `db:test` (και `build` αν άλλαξαν ρυθμίσεις/εξαρτήσεις). Αν κάτι αποτυγχάνει, πες το καθαρά.

## Δομή
```
src/app/              routes, layout, providers
src/features/<name>/  components/, hooks/, api.ts, schema.ts, *.test.ts
                      (booking, calendar, clients, services, staff, insights, settings)
src/shared/ui/        design system components
src/shared/motion/    useReducedMotion, useInView, useCountUp, SplitWords, RollText, motion.css (ADR-0011)
src/shared/lib/       επανεξάγει τα _shared (money, dates, phone, sms, sms-templates, domain, onesignal)
                      + supabase client (μόνο pro), publicApi (fetch /api), env, theme, database.types.ts
src/shared/i18n/      i18next, {el,en}/{common,booking,pro}.json (ίδια κλειδιά ανά namespace — το ελέγχει
                      test)· η σελίδα κράτησης φορτώνει μόνο common + booking
src/styles/tokens.css design tokens
packages/verticals/   πρότυπα κλάδων (JSON)
supabase/migrations/  0001_*.sql … (αριθμημένα)
supabase/tests/       pgTAP (*.test.sql)
supabase/functions/_shared/  κώδικας κοινός web + Edge Functions (Deno): money, dates, phone, sms,
                      sms-templates, domain (+ Vitest tests). Alias `@fn-shared`, imports με `.ts`.
                      proxy-contract (συμβόλαιο /api ⇄ functions), http, cors, push-templates.
supabase/functions/<name>/index.ts  Edge Functions (Deno)· καθεμία με [functions.<name>] στο config.toml
supabase/templates/   πρότυπα email του Auth (κωδικός σύνδεσης, χωρίς link)
supabase/provision/   ΜΟΝΟ συνθετικά *.example.json (τα πραγματικά ζουν εκτός repo)
edge/                 Cloudflare Worker (ADR-0008): api-proxy, cookies, inject, booking-shell, worker,
                      wrangler.jsonc. Τα ίδια modules τρέχουν ως middleware του Vite.
scripts/              npm scripts (Node)· scripts/lib/ κοινά helpers + Vitest (*.test.mjs)
e2e/                  Playwright (e2e/lib: fixtures, login μέσω Mailpit, seed users)
docs/                 SPEC.md, adr/, plans/, design/MOTION.md, SETUP.md, runbooks/
```

## Κανόνες κώδικα (υποχρεωτικοί)
1. **Όχι `any`.** Τύποι βάσης μόνο από `npm run gen:types`.
2. **Τα components δεν καλούν Supabase.** Όλη η πρόσβαση δεδομένων από το `api.ts` κάθε feature, μέσω TanStack Query hooks.
3. **Όχι business logic σε components.** Component → hook → lib/service → api.
4. **Κάθε εξωτερική είσοδος περνά από Zod** (frontend και Edge Functions, κοινά schemas στο `supabase/functions/_shared/`).
5. **Χρήματα:** πάντα integer cents, μόνο μέσω `money.ts`. Ποτέ float.
6. **Ημερομηνίες:** `timestamptz` (UTC) στη βάση· εμφάνιση στη ζώνη `businesses.timezone` μέσω `dates.ts`. **Ποτέ καρφωτό `Europe/Athens`.** Ωράρια = τοπικές ώρες.
7. **Τηλέφωνα:** E.164 (`+3069…`) μόνο μέσω `phone.ts`. Το τηλέφωνο **δεν** είναι μοναδικό κλειδί πελάτη.
8. **Καμία καρφωτή φράση UI**, ούτε σε SMS/email/push/validation — όλα i18n. Εξαιρέσεις θέσης: τα κείμενα SMS στο `supabase/functions/_shared/sms-templates.ts` (ADR-0007), τα κείμενα push στο `supabase/functions/_shared/push-templates.ts` (ADR-0010, από το 1.1) και τα κείμενα των email ασφαλείας στο `supabase/functions/_shared/security-email-templates.ts` (ADR-0009, από το 1.9), el/en με test el = en, γιατί τα στέλνουν οι Edge Functions· το στατικό δίγλωσσο πρότυπο του email σύνδεσης στο `supabase/templates/` (ADR-0009 §6), γιατί το στέλνει το Auth, μέχρι το Send Email Hook.
9. **SMS μόνο μέσω `renderSms`/`prepareSms`:** μετατροπή σε GSM-7 (ελληνικά σε κεφαλαία χωρίς τόνους, look-alike → λατινικά· τα λατινικά/links μένουν ίδια), χωρίς €. Κάθε πρότυπο έχει τεστ ότι με τις μεγαλύτερες τιμές βγαίνει **1 SMS** και το link φτάνει byte-byte.
10. Components < ~200 γραμμές. Αν μεγαλώνουν, σπάσ' τα.
11. **Configuration, όχι forks:** καμία λογική τύπου `if (business.slug === '…')`. Οι διαφορές πάνε σε `settings`/`theme`/πρότυπα κλάδου.
12. Διαθεσιμότητα και κράτηση υπολογίζονται **server-side σε SQL**. Ο browser δεν είναι source of truth. Η σελίδα κράτησης δεν φορτώνει supabase-js (fetch στο `/api`).
13. **Κάθε λογική σε μία γλώσσα:** ό,τι είναι σε SQL τεστάρεται με pgTAP, ό,τι είναι σε TS με Vitest. Ποτέ η ίδια λογική και στις δύο.
14. Οι μεταβολές ραντεβού δεν δείχνουν ποτέ «επιτυχία» πριν απαντήσει ο server (όχι optimistic create/move).

## Κανόνες βάσης
- Migrations **μόνο μέσω Supabase CLI** (npm scripts), ποτέ από τον SQL editor.
- **Μέχρι να μπουν τα πρώτα πραγματικά δεδομένα** τα migrations επιτρέπεται να αλλάζουν (με `db:reset`). Μετά το squash σε baseline: **ποτέ δεν αλλάζεις migration που έχει τρέξει**, πάντα νέο αριθμημένο αρχείο.
- **Κάθε νέος πίνακας έρχεται στο ίδιο migration με το RLS, τις πολιτικές και τα ρητά GRANT του.** Το `anon` δεν παίρνει ποτέ δικαίωμα σε πίνακα. Ενημέρωσε τις allow-lists στο `supabase/tests/01_security.test.sql` συνειδητά.
- Κάθε πίνακας επιχείρησης έχει `business_id not null`. Κάθε γονικός έχει `unique (business_id, id)` και κάθε αναφορά είναι **σύνθετο FK** `(business_id, x_id)`.
- Πολιτικές RLS στη μορφή `business_id in (select private.my_business_ids())` / `private.my_business_ids_with_role(array[...])` / `staff_id in (select private.my_staff_ids())` (υπολογίζονται μία φορά ανά ερώτημα).
- **Μοτίβο RPC:** η λογική σε `private.<name>_impl` (SECURITY DEFINER, `set search_path = ''`, κάνει η ίδια ελέγχους μέλους/ρόλου)· το API βλέπει λεπτό wrapper στο `public` (SECURITY INVOKER) με ρητό `GRANT EXECUTE` ανά ρόλο. Καμία SECURITY DEFINER function στο `public`. `EXECUTE` κλειστό για PUBLIC (και global).
- Ποιος ενεργεί (`anaklo.actor_type`, με `set_config(…, true)` μέσα στο `_impl`): οι RPCs κράτησης/διαχείρισης για πελάτες `client`· τα cron jobs `system`· ο importer `import`· seed και fixtures των tests `system`. Οι RPCs του `authenticated` **δεν** δηλώνουν τίποτα (→ `staff`) και ποτέ `system`. Edge Functions και scripts γράφουν ραντεβού μόνο μέσω RPC που δηλώνει actor. Χωρίς δήλωση και χωρίς συνδεδεμένο χρήστη → `42501`· άγνωστη τιμή → `22023` (ποτέ σιωπηρό `system`).
- Ο έλεγχος ρόλου/ποσών ζει στη definer `_impl`, ποτέ μόνο στο wrapper.
- Κρίσιμες ενέργειες (ανωνυμοποίηση, μέλη/ρόλοι/owner, slug/ζώνη/νόμισμα, εξαγωγή, συσκευές κωδικών, απενεργοποίηση επιχείρησης) → `private.require_fresh_totp()` μέσα στο `_impl` (aal2 + `totp` στο `amr` ≤ 5′, hints `aal2_required`/`fresh_totp_required`)· ποτέ μόνο στο UI· όχι σε καθημερινές ενέργειες. `business_members` αλλάζει μόνο μέσω RPC.
- Στήλες που δεν αλλάζουν από την εφαρμογή → UPDATE **ανά στήλη** (π.χ. `businesses`: όχι slug/timezone/currency/vertical· τα τρία πρώτα μόνο με RPC του owner με φρέσκο κωδικό, `change_business_identity` στο 1.7· το vertical μόνο στη δημιουργία).
- Ωράρια/εξαιρέσεις: exclusion constraints κατά επικάλυψης. `time_off.reason` ουδέτερο (ποτέ δεδομένα υγείας).
- Online κράτηση ⇔ `verified_via` (otp|trusted_device). `clients.phone_verified_at` το γράφει μόνο η ροή OTP.
- Signup κλειστό: λογαριασμοί μόνο με provisioning της Nous, πρόσκληση από owner με φρέσκο κωδικό (1.7) ή onboarding (Φάση 5).
- Καταστάσεις/τύποι ως `text` + `CHECK`, όχι Postgres enums. Οι λίστες τιμών ζουν και στο `_shared/domain.ts` (test ελέγχει ότι ταιριάζουν).
- `appointments`: exclusion constraint (btree_gist) κατά διπλοκράτησης για status `booked|confirmed`.
- **`appointment_events` από την πρώτη μέρα:** trigger σε INSERT και σε αλλαγή status/ώρας/επαγγελματία. Μόνο INSERT, χωρίς προσωπικά στοιχεία.
- **Διαγραφή GDPR = ανωνυμοποίηση** (`erase_client`), όχι cascade delete. FK προς `clients` με `RESTRICT`.
- Συναινέσεις στο `client_consents` με `legal_basis` (όχι boolean). Μάρκετινγκ **μόνο** με νόμιμη βάση. Η εισαγωγή πελατών δεν δημιουργεί ποτέ συναίνεση **μάρκετινγκ** (CHECK στη βάση). Μια συναίνεση δεν αλλάζει ποτέ, μόνο ανακαλείται μία φορά (trigger σε κάθε UPDATE, και για `service_role`· μόνη εξαίρεση το `created_by → null` όταν σβήνεται ο λογαριασμός). Η εφαρμογή γράφει συναινέσεις **μόνο** μέσω `set_client_consent` (από το 0010)· ο κανόνας κατάστασης ζει **μόνο** στο `private.consent_state` (η πιο πρόσφατη ενεργή εγγραφή της οικογένειας).
- Οικογένεια πελάτη = ο πελάτης + όσοι συγχωνεύτηκαν σε αυτόν (`merged_into_id`): κάθε ανάγνωση/εγγραφή πελάτη (καρτέλα, συναινέσεις, ανωνυμοποίηση, «μνήμη») περνά από το `private.client_family`.
- Λογική «μνήμης» σε **μία** SQL function (`private.client_memory_impl(business_id, as_of)` + public wrapper), με pgTAP. Όχι materialized view. Κανόνες: SPEC §4.
- Expand/contract: πρώτα προσθέτεις, αφαιρείς σε επόμενη έκδοση. Σειρά deploy: migration → Edge Functions → frontend.
- Ο χρήστης εφαρμόζει τα migrations στο remote. Όταν φτιάχνεις migration, **πες του ρητά**: νέο migration → `npm run db:push` (+ `npm run db:test:dev`· προαιρετικό πριν το 1.10) και, από το 1.10, `npm run secrets:dev` → `npm run db:test:dev` → `npm run deploy:dev`· αλλαγή σε migration που έχει ήδη σταλεί (μόνο πριν τα πραγματικά δεδομένα) → `npm run db:reset:dev` → `npm run secrets:dev` → `npm run provision:dev` → `npm run db:test:dev` → `npm run deploy:dev` (τα secrets/provision/deploy τρέχουν από το 1.10· το reset σβήνει τα δεδομένα του provisioning και ίσως το Vault). Το `deploy:dev` ανεβάζει και τις Edge Functions και τον Worker.

## Δοκιμές
- Vitest (UTC μέσω `vitest.config.ts`, όχι `TZ=` στο script): money/dates/phone/sms (1 SMS/πρότυπο), λίστες τιμών = CHECK, i18n el = en, schemas, λογική UI.
- pgTAP: RLS και απομόνωση επιχειρήσεων (Α δεν διαβάζει/γράφει Β), allow-lists δικαιωμάτων (πίνακες, στήλες & functions), default privileges, σύνθετα FK, constraint διπλοκράτησης, επικαλύψεις ωραρίων, δηλωμένος actor, μεταβάσεις/διορθώσεις κατάστασης, events, αναζήτηση, διαθεσιμότητα (DST, μεσάνυχτα, ρεπό, μισή μέρα, δεύτερη ζώνη), κράτηση, «μνήμη», ανωνυμοποίηση.
- Playwright (mobile viewport): Instagram → κράτηση → επιβεβαίωση · ακύρωση · γρήγορο ραντεβού/walk-in · άδεια με ραντεβού · (v1) at-risk → win-back · (Φάση 5) onboarding.
- Νέα λειτουργία = νέα tests. Μην σβήνεις/χαλαρώνεις tests για να περάσουν.

## Git
- `main` πάντα deployable. Branches `feat/…`, `fix/…`, `chore/…`.
- Conventional commits: `feat(booking): add one-tap rebook`.
- Commit μόνο όταν το ζητήσει ο χρήστης. Ποτέ `push --force` στο `main`.
- Ποτέ secrets στο git. **Ποτέ πραγματικά δεδομένα πελατών** (CSV, dumps) — seed μόνο συνθετικό. Κράτα ενημερωμένο το `.env.example`.

## Σε κάθε release (από την έναρξη του πιλότου)
- Ενημέρωσε `CHANGELOG.md` **και** το «Τι νέο υπάρχει» μέσα στην εφαρμογή (bump version).

## UI / απόδοση
- Mobile-first, ένα χέρι. Κουμπιά ≥ 44px, **inputs ≥ 16px** (αποφυγή zoom iOS), `overflow-x: clip` στο root.
- Μία κύρια ενέργεια ανά οθόνη. **Κάθε μετρική με κουμπί ενέργειας** («Δες πελάτες»).
- Θέμα ανά επιχείρηση → CSS variables στο `:root`, με έλεγχο αντίθεσης WCAG AA. Γραμματοσειρές μόνο από επιλεγμένη λίστα με ελληνικά, self-hosted — ποτέ Google Fonts CDN.
- Σελίδα κράτησης: αρχικό JS ≤ 120KB gzip (`npm run size`, στο τέλος της Φάσης 0: 100.7KB· μετά το 1.3: 109.4KB), LCP < 2s σε 4G, να δουλεύει στον in-app browser Instagram/Facebook, χωρίς λογαριασμό. Χωρίς supabase-js, router, RHF· μόνο `zod/mini` (το επιβάλλει το ESLint).
- Skeletons αντί για spinners.
- Εμφάνιση: **Κατεύθυνση Δ** (ADR-0011, προδιαγραφή `docs/design/MOTION.md`, κωδικοί G1–G7/E1–E19). Components μόνο με σημασιολογικά tokens (`--color-*`), όχι απευθείας `--lux-*`· χρυσό μόνο σε σκούρο φόντο.
- Κίνηση: **μόνο `transform`/`opacity`** (εξαιρέσεις μόνο όσες ορίζει το MOTION.md)· `prefers-reduced-motion` → καμία κίνηση, **με test**· **χωρίς βιβλιοθήκη κίνησης**, μόνο CSS + `src/shared/motion`.
- Hover μόνο σε `(hover: hover) and (pointer: fine)`, σε αφή μόνο `scale(.97)`· η κίνηση δεν καθυστερεί ποτέ ενέργεια (επιβεβαίωση μόνο μετά την απάντηση του server). Επίπεδα: κράτηση μεσαίο (χωρίς splash/scroll-linked), εφαρμογή ελάχιστο.
- Κάθε κίνηση μπαίνει μαζί με την οθόνη που τη χρησιμοποιεί· Definition of Done: MOTION.md §6.

## Περιβάλλον (Windows)
- Το project είναι στο `C:\Users\mixal\mnemo` — **χωρίς ελληνικούς χαρακτήρες στο path, εκτός OneDrive.**
- Ο χρήστης δουλεύει σε Windows· χρησιμοποίησε npm scripts αντί για bash-only εντολές. Docker Desktop (WSL2) για το τοπικό Supabase.
- Line endings: LF (`.gitattributes`).

## Εκτός scope μέχρι νεωτέρας
AI ρεσεψιονίστ, AI σύνοψη, Wallet, προκαταβολές, Viber, native apps, custom domains, δεδομένα υγείας, πόροι/καμπίνες, holds, push σε πελάτες, analytics τρίτων στη σελίδα κράτησης. Μην τα υλοποιείς χωρίς ρητή εντολή.

## Τρόπος δουλειάς
- Για μεγάλες αλλαγές (νέο feature, αλλαγή σχήματος βάσης): **πρώτα σύντομο πλάνο**, μετά κώδικας.
- Μην προσθέτεις βιβλιοθήκες χωρίς λόγο· αν προσθέσεις, πες γιατί.
- Στο τέλος κάθε εργασίας: 1–3 γραμμές τι άλλαξε + τι πρέπει να κάνει ο χρήστης (migration, env var, redeploy).
