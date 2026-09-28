# Πλάνο Φάσης 1 — Πυρήνας κράτησης

- Κατάσταση: **εγκρίθηκε 2026-09-27** (Μιχάλης), με τις αλλαγές C1–C5 και τις προσθήκες TOTP της ίδιας μέρας (δεύτερη συσκευή, ανάκτηση από τη Nous, πολιτική session· βλ. 1.7). **2026-09-28:** εγκρίθηκε ο φρέσκος κωδικός για τις κρίσιμες ενέργειες (C6, βλ. 1.7 και 1.9)
- Διάρκεια: **37 εργάσιμες + 3 buffer** (~8 εβδομάδες)· σύνοψη στο [SPEC §14](../SPEC.md#14-βήματα-υλοποίησης)
- Πηγές: SPEC v0.4, ADR-0001–0010 (τα 0008–0010 γράφτηκαν μαζί με αυτό το πλάνο), ο κώδικας στο `d648dd8` (migrations 0001–0003, pgTAP 01–07). Αν κάτι εδώ συγκρούεται με το SPEC ή με ADR, σταματάμε και ρωτάμε.

| Βήμα   | Περιεχόμενο                                                                | Μέρες | Τέλος (μέρα) | Migration                    | pgTAP                                          |
| ------ | -------------------------------------------------------------------------- | ----- | ------------ | ---------------------------- | ---------------------------------------------- |
| 1.1    | Υποδομή: Worker, proxy, σύνδεση προσωπικού, toolchain, provisioning, δοκιμές σε συσκευές | 5     | 5            | —                            | —                                              |
| 1.2    | Διαθεσιμότητα και κράτηση σε SQL                                           | 4,5   | 9,5          | `0004_availability_booking`  | `08_availability`, `09_booking` (+ `01`, `02`) |
| 1.3    | Online κράτηση end-to-end                                                  | 6,5   | 16           | `0005_public_booking`        | `10_public_booking`                            |
| 1.4    | PWA επαγγελματία                                                           | 3,5   | 19,5         | `0006_day_ops`               | `11_day_ops`                                   |
| 1.5    | Ειδοποιήσεις (1.5a + 1.5b)                                                 | 3,5   | 23           | `0007_messaging` (μόνο 1.5a) | `12_messaging`                                 |
| 1.6    | Οθόνες ρυθμίσεων και έκτακτη απουσία                                       | 4     | 27           | `0008_schedule_ops`          | `07_schedules` (επέκταση), `13_schedule_ops`   |
| 1.7    | Ασφάλεια και μέλη: TOTP, δεύτερη συσκευή, ανάκτηση, φρέσκος κωδικός, προσκλήσεις, ταυτότητα | 5     | 32           | `0009_members_identity`      | `14_members_identity`                          |
| 1.8    | Καρτέλα πελάτη, συγχώνευση, ανωνυμοποίηση                                  | 2,5   | 34,5         | `0010_client_ops`            | `15_client_ops`                                |
| 1.9    | Παρακολούθηση, ανίχνευση αλλαγών στις συσκευές κωδικών, τελική πρόβα      | 2,5   | 37           | `0011_health`                | `16_health`                                    |
| Buffer |                                                                            | 3     | 40           |                              |                                                |

«Μέρα Ν» = εργάσιμη μέρα της Φάσης 1. Αν η μέρα 1 είναι η Δευτέρα 2026-09-28: η 2026-10-28 είναι αργία, η μέρα 37 πέφτει 2026-11-18 και το buffer τελειώνει 2026-11-23. Η αλλαγή ώρας της 2026-10-25 πέφτει μέσα στο 1.5a.

## Αποφάσεις

| Θέμα                            | Απόφαση                                                                                                                                                                                                                                                                    | Τεκμηρίωση                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| D1 Hosting                      | Cloudflare Workers: static assets και **ένας** Worker για τη σελίδα κράτησης, το `/app`, το `/<slug>` με Open Graph και το `/api` proxy, που κρατά και το cookie της έμπιστης συσκευής.                                                                                    | ADR-0008 (1.1)· SPEC §6, §18 ερ. 2                |
| D2 Domains                      | `anaklo.gr` (prod), `dev.anaklo.gr` (dev), DNS στο Cloudflare από τη μέρα 1. Resend σε sending subdomain (π.χ. `mail.anaklo.gr`), περιοχή EU.                                                                                                                              | ADR-0008· ADR-0007 (link ≤ 40)                    |
| D3 Λογαριασμοί SMS              | 2–3 δοκιμαστικοί λογαριασμοί σε ελληνικούς παρόχους (π.χ. Apifon, Routee, Yuboto) από τη μέρα 1, επιλογή γύρω στη μέρα 12. Συμβάσεις, sender ID και DPA υπογράφει ο Μιχάλης προσωπικά μέχρι να υπάρξει η Nous.                                                             | SPEC §18 ερ. 1, 4                                 |
| D4 Σύνδεση προσωπικού           | Κωδικός email 6 ψηφίων: `signInWithOtp` με `shouldCreateUser: false`, μετά `verifyOtp` με `type: 'email'`. Όχι magic links (ανοίγουν στο Safari, έξω από την εγκατεστημένη PWA), όχι κωδικοί πρόσβασης, όχι SMS. Emails Auth μέσω Resend SMTP. Signup κλειστό.             | ADR-0009 (1.1)· SPEC §11                          |
| D5 Push                         | OneSignal αν περάσει η δοκιμή του 1.1, αλλιώς απλό Web Push (VAPID).                                                                                                                                                                                                       | ADR-0010 (προτεινόμενο μέχρι τη δοκιμή)· SPEC §6, §12 |
| D6 Μέλη και ταυτότητα           | Προσκλήσεις μελών (Edge Function) και RPC του owner για slug, ζώνη ώρας και νόμισμα **μέσα** στη Φάση 1 (1.7). Το `vertical` γράφεται μόνο στη δημιουργία και δεν αλλάζει στη Φάση 1.                                                                                       | SPEC §11, §14· ADR-0005                           |
| D7 Αναβολές                     | Στη Φάση 3: καθημερινό email στον owner, UI συγχώνευσης πελατών, Realtime.                                                                                                                                                                                                 | SPEC §14                                          |
| D8 «Στρίμωγμα» σε buffer        | Μόνο σε λειτουργία προσωπικού, με ρητό flag και προειδοποίηση, ποτέ πάνω σε χρόνο υπηρεσίας. Η online κράτηση σέβεται πάντα τα buffers. Το `blocked_until` μένει απορριφθέν.                                                                                               | SPEC §7, §8                                       |
| D9 Υπηρεσίες ανά online κράτηση | Μία στη Φάση 1. Η SQL δέχεται ήδη πίνακα υπηρεσιών.                                                                                                                                                                                                                        | ADR-0003                                          |
| D10 Τεχνικές προτάσεις          | Υιοθετούνται όλες οι προτάσεις της κριτικής του πλάνου και της συμφιλίωσης με τη σκλήρυνση (σύνοψη παρακάτω).                                                                                                                                                              | αυτό το πλάνο                                     |
| C1 Σειρά περικοπών              | Sentry στη σελίδα κράτησης → μετακίνηση από το link διαχείρισης → οθόνες πολιτικής κρατήσεων. Οι οθόνες κλεισιμάτων **δεν** κόβονται.                                                                                                                                      | SPEC §14                                          |
| C2 Χωρίς Realtime               | Το ημερολόγιο κάνει refetch όταν η εφαρμογή ξαναπάρει focus και κάθε 60″, μαζί με το push.                                                                                                                                                                                 | SPEC §6, §14                                      |
| C3 TOTP                         | Οι restrictive πολιτικές `aal2` στο `business_members` (Φάση 0) απαιτούν MFA: ροή εγγραφής TOTP για owner/manager **πριν** τις προσκλήσεις. Με τις προσθήκες της 2026-09-27 (δεύτερη συσκευή, οθόνη χαμένης συσκευής, διαδικασία reset της Nous, πολιτική session, οδηγός σε απλή γλώσσα) το κόστος είναι ~2,5 μέρες, από τις οποίες ~0,5 ήταν ήδη στο πλάνο για το step-up της ανωνυμοποίησης: **καθαρά +2 μέρες** (+1 η αρχική C3, +1 οι προσθήκες). Σχέδιο στο 1.7. | ADR-0009· SPEC §11                                |
| C4 Κριτήρια SMS                 | Pass/fail: GSM-7 χωρίς αυτόματη μετατροπή σε UCS-2, delivery webhooks, αλφαριθμητικό sender ID, προπληρωμένος λογαριασμός ή σκληρό όριο δαπάνης. Πίνακας στο 1.5b.                                                                                                         | SPEC §6, §18 ερ. 1· ADR-0007                      |
| C5 Δοκιμή push                  | Στο 1.1, με την PWA **εγκατεστημένη στην αρχική οθόνη iPhone** (iOS ≥ 16.4).                                                                                                                                                                                               | SPEC §6· ADR-0010                                 |
| C6 Φρέσκος κωδικός              | **2026-09-28** (Μιχάλης, «Ναι στο step-up»). Οι κρίσιμες ενέργειες θέλουν session `aal2` **και** κωδικό από την εφαρμογή κωδικών των τελευταίων 5′ (`totp` στο `amr` του JWT), με έλεγχο στον server μέσα σε κάθε `_impl` (`private.require_fresh_totp()`), ποτέ μόνο στο UI: ανωνυμοποίηση πελάτη, αλλαγές μελών/ρόλων (και προσθήκη/αφαίρεση owner), αλλαγή slug/ζώνης ώρας/νομίσματος, εξαγωγή πελατολογίου, αλλαγή/αφαίρεση συσκευών κωδικών, απενεργοποίηση επιχείρησης. Όχι στις καθημερινές ενέργειες. Το `business_members` αλλάζει μόνο μέσω RPC. Το Supabase Pro δεν έχει hook που να αρνείται αλλαγές παραγόντων, άρα: αφαίρεση συσκευής μόνο μέσω `manage-factors`, προσθήκη μόνο με άδεια, ανίχνευση κάθε μη εγκεκριμένης αλλαγής (1.9): ο νέος ξένος παράγοντας σβήνεται, μια αφαίρεση δεν αναστρέφεται· και στις δύο ανάκληση sessions και ειδοποίηση. Το ερώτημα της φρεσκάδας έκλεισε με αυτή την απόφαση. Κόστος **+2 μέρες** (+1 στο 1.7, +1 στο 1.9). | ADR-0005, ADR-0009· SPEC §11 |

**Τεχνικές αποφάσεις (D10)**

- Το staff κλείνει ραντεβού και για συναδέλφους (κοινό κινητό του μαγαζιού), αλλά μετακινεί, ακυρώνει και σημειώνει μόνο τα δικά του. Owner και manager: όλα.
- OTP: 3 ανά αριθμό/ώρα, 10 ανά IP/ώρα, 40 ανά επιχείρηση/ημέρα, πλατφορμικό ημερήσιο όριο (π.χ. 300 στο dev). Μόνο +3069, και μόνο αφού επιλεγεί ώρα που είναι ακόμη ελεύθερη.
- Dev: `OTP_TEST_NUMBERS` με σταθερό κωδικό, `SMS_ALLOWED_RECIPIENTS`, έως 30 SMS/ημέρα, όλα απορρίπτονται στην εκκίνηση όταν `ANAKLO_ENV=prod`. Τοπικά και στο CI: ψεύτικος adapter. Μόνο το `anaklo-dev` στη Φάση 1· επιχειρήσεις demo και πιλότου από script provisioning (JSON εκτός repo).
- Υπενθύμιση 24ω πριν (προεπιλογή) ή το προηγούμενο απόγευμα (ρύθμιση)· ώρες ησυχίας 22:00–09:00 τοπική ώρα. Ένας planner σε SQL, `private.plan_messages_impl`, που τον καλούν ρητά οι RPCs· κανένας γενικός trigger στο `appointments`.
- Link διαχείρισης: **νέο token σε κάθε μήνυμα** και σε κάθε idempotent επανάληψη κράτησης· το `messages_log` κρατά μόνο `booking_token_id`. Link νέας κράτησης: `/r/<code>` (σταθερός κωδικός επιχείρησης), ώστε κάθε link να χωρά στα 40 σύμβολα όποιο κι αν είναι το slug.
- Μετά το `verify`: **εφάπαξ verification grant** (~10′, μόνο στη μνήμη της σελίδας). Το cookie της έμπιστης συσκευής χρησιμεύει μόνο για να μη ζητηθεί OTP την επόμενη φορά· αν το ρίξει ο browser, η ροή δεν κολλά.
- Κατάλογοι i18n ανά namespace (`common`, `booking`, `pro`)· η σελίδα κράτησης φορτώνει μόνο `common` + `booking`. Η έγχυση στο `/<slug>` είναι καθαρή συνάρτηση πάνω σε string, κοινή για Worker και dev server.
- Δύο wrappers κράτησης, όπως στο SPEC §7: `public.book_appointment` (μόνο `service_role`: online κράτηση μέσω της Edge Function `public-booking`) και `public.staff_book_appointment` (`authenticated`: λειτουργία προσωπικού). Αυτό εξειδικεύει το ADR-0003, που έγραφε ένα wrapper και για τους δύο ρόλους, και σημειώνεται εκεί.
- Email σύνδεσης: το ενσωματωμένο πρότυπο του Supabase με στατικό δίγλωσσο κείμενο, ως καταγεγραμμένη εξαίρεση του κανόνα 8 (ADR-0009)· Send Email Hook πριν την εμπορική διάθεση.
- `messaging_enabled = false` σταματά τις υπενθυμίσεις (και αργότερα το μάρκετινγκ) της επιχείρησης, ποτέ OTP, επιβεβαιώσεις ή ακυρώσεις. Ο πλατφορμικός διακόπτης σταματά τα πάντα· τότε η σελίδα δείχνει το τηλέφωνο της επιχείρησης.

## Σειρά περικοπών

Η σύγκριση πραγματικού και πλάνου γίνεται στο τέλος κάθε βήματος. Αν η προβλεπόμενη υπέρβαση ξεπερνά το buffer που απομένει, κόβουμε με αυτή τη σειρά ό,τι δεν έχει ακόμη υλοποιηθεί:

1. **Sentry στη σελίδα κράτησης.** Μένει στην PWA και στις Edge Functions.
2. **Μετακίνηση ραντεβού από το link διαχείρισης.** Μένουν η ακύρωση και το link νέας κράτησης. Το `move_core` μένει (το χρησιμοποιεί το 1.4). Γίνεται τελευταία μέσα στο 1.3.
3. **Οθόνες πολιτικής κρατήσεων.** Οι τιμές μπαίνουν από το provisioning. Γίνονται τελευταίες μέσα στο 1.6.

Οι οθόνες **κλεισιμάτων δεν κόβονται ποτέ**.

## Κανόνες για όλα τα βήματα

**Ποιος ενεργεί (`anaklo.actor_type`)**

- Κάθε εγγραφή ραντεβού δηλώνει actor. Χωρίς δήλωση και χωρίς JWT: `42501`· άγνωστη τιμή: `22023` (`private.current_actor_type()`).
- Στον κώδικα της εφαρμογής, `system` και `import` δηλώνουν μόνο τα cron jobs (**μέσα** στο `_impl`, γιατί το pg_cron τρέχει ως postgres χωρίς JWT) και τα `_impl` χωρίς GRANT σε `anon`/`authenticated` (π.χ. το `merge_clients_core` με `import`). Εξαιρούνται το `seed.sql` και τα fixtures των tests (βλ. «pgTAP» παρακάτω). Οι RPCs του `authenticated` **ποτέ** `system`: δεν δηλώνουν τίποτα (→ `staff`). Οι RPCs κράτησης και διαχείρισης για πελάτες δηλώνουν `client`.
- Edge Functions, scripts, fixtures του Playwright και ο importer της Φάσης 3 **δεν** γράφουν ποτέ `appointments` μέσω πινάκων του PostgREST, πάντα μέσω RPC που δηλώνει actor. Το `seed.sql` συνεχίζει να δηλώνει `system`, και τα απευθείας inserts του δεν προγραμματίζουν μηνύματα.

**pgTAP**

- Νέα αρχεία από το `08`, με την αρίθμηση του πίνακα στην αρχή. Κάθε αρχείο ξεκινά όπως το `07_schedules`: `begin;`, `create extension if not exists pgtap with schema extensions;`, `set local role postgres;`, `set local search_path = public, extensions;`.
- Πριν από τα fixtures: `select set_config('anaklo.actor_type', 'system', true);`. Πριν από κάθε βήμα που ενεργεί ως staff: `select set_config('anaklo.actor_type', '', true);`, αλλιώς το δηλωμένο `system` κερδίζει το JWT και το test περνά για λάθος λόγο.
- Ό,τι χρειάζεται κλειδί από Vault το γράφει μέσα στο transaction του test **με upsert** (`vault.update_secret` αν υπάρχει ήδη το όνομα, αλλιώς `vault.create_secret`), ώστε να τρέχει και με `db:test:dev` μετά το `secrets:dev`. Το rollback επαναφέρει την τιμή. Τα `_impl` που μηδενίζουν ποσά ή καλούν `private.require_fresh_totp()` τεστάρονται και απευθείας.
- Φρέσκος κωδικός (C6): το test γράφει στο `request.jwt.claims` τα `aal` και `amr` (π.χ. `[{"method":"totp","timestamp":<epoch>}]`), με timestamp σχετικό με το `now()` της συναλλαγής, και ορίζει **ρητά** το `private.platform_settings.fresh_totp_max_age_seconds` μέσα στη συναλλαγή (το τοπικό seed έχει άλλη τιμή, βλ. 1.7). Έτσι τρέχει ίδια τοπικά και με `db:test:dev`.

**Migrations**

- Ένα migration ανά βήμα, με τη σειρά του πίνακα (0004–0011)· το 1.5b δεν έχει. Κανένα βήμα δεν χρειάζεται migration μεταγενέστερου βήματος. Κάθε πίνακας έρχεται με RLS, πολιτικές και ρητά GRANT στο ίδιο αρχείο.
- Ο planner έχει σταθερή υπογραφή από το 0004: `private.plan_messages_impl(p_appointment_id uuid, p_change text)`, με κενό σώμα. Τα 0005 και 0007 αλλάζουν μόνο το σώμα του (`create or replace`), οπότε οι καλούντες δεν αλλάζουν.
- Αλλαγή σε migration που έχει ήδη σταλεί (μόνο πριν τα πραγματικά δεδομένα): `npm run db:reset:dev` → `npm run secrets:dev` → `npm run provision:dev` → `npm run db:test:dev` → `npm run deploy:dev`. Το reset σβήνει τα δεδομένα του provisioning (και τα μέλη) και ίσως τα μυστικά του Vault· το `secrets:dev` κάνει upsert, άρα ξανατρέχει χωρίς πρόβλημα. Τα cron jobs τα ξαναφτιάχνουν τα migrations με `cron.schedule('<όνομα>', …)`. Μετά από κάθε αλλαγή σχήματος: `npm run gen:types`.

**Δικαιώματα**

- Κάθε νέος πίνακας, function ή GRANT ενημερώνει συνειδητά τις allow-lists του `01_security`: `anon`, `authenticated` και, από το 1.2, ρητή λίστα `service_role` (functions και πίνακες).
- Πίνακες της Φάσης 1 που δεν τους διαβάζει η εφαρμογή (OTP, tokens, outbox, όρια, suppression): RLS και **κανένα** GRANT σε `anon`, `authenticated` ή `service_role`· πρόσβαση μόνο μέσω RPC.
- Κάθε νέα στήλη του `businesses` έχει ρητή απόφαση `grant update (στήλη)` στο `authenticated` ή όχι, και η λίστα στηλών του `01_security` αλλάζει στο ίδιο βήμα.
- Ποσά που εξαρτώνται από τον ρόλο μηδενίζονται **μέσα** στο `private.*_impl` (ρόλος από `business_members`), ποτέ στο wrapper. Κανένα `_impl` δεν ελέγχει σκέτο `aal2`: όπου χρειάζεται δεύτερο βήμα (οι κρίσιμες ενέργειες, παρακάτω), το `_impl` καλεί το `private.require_fresh_totp()`, που ελέγχει και το `aal2` (hint `aal2_required`) και τη φρεσκάδα (hint `fresh_totp_required`).
- **Κρίσιμες ενέργειες (C6, λίστα στο 1.7):** το `_impl` καλεί το ίδιο το `private.require_fresh_totp()`, μετά τον έλεγχο συμμετοχής και ρόλου· ποτέ μόνο το UI ή το wrapper. Σφάλμα `42501` με hint `aal2_required` (session `aal1`) ή `fresh_totp_required` (`aal2` χωρίς κωδικό των τελευταίων 5′). Μία υλοποίηση σε SQL (`private.has_fresh_totp()`/`private.require_fresh_totp()`), καμία σε TypeScript· γι' αυτό το φύλλο κωδικού ανοίγει μόνο όταν το ζητήσει ο server, ποτέ προληπτικά. Μια Edge Function που κάνει κρίσιμη ενέργεια καλεί **πρώτα** RPC ως ο χρήστης (ίδιος έλεγχος) και μόνο μετά φτιάχνει client `service_role`. Οι καθημερινές ενέργειες δεν ζητούν φρέσκο κωδικό.
- **`business_members` μόνο μέσω RPC** από το 0009: ο `authenticated` κρατά μόνο `SELECT`· κάθε αλλαγή μέλους περνά από τα RPCs του 1.7 (και το RPC πρόσκλησης, μόνο `service_role`). Οι restrictive πολιτικές `aal2` της Φάσης 0 μένουν ως δεύτερη γραμμή άμυνας.

**Απομόνωση επιχειρήσεων στις RPCs**

- Κάθε RPC του `authenticated` παίρνει πρώτη παράμετρο `p_business_id`. Το `_impl` ελέγχει συμμετοχή **πρώτα**, πριν από κάθε άλλο όρισμα, και ότι κάθε id οντότητας ανήκει στο `p_business_id` (αλλιώς `42501`). Μόνη εξαίρεση το `authorize_factor_change` (1.7): αφορά μόνο τους παράγοντες του ίδιου του χρήστη (`auth.uid()`), που δεν ανήκουν σε επιχείρηση.
- Το `02_tenant_isolation` αποκτά στο 1.2 γενικό βρόχο: για κάθε function του `public` που εκτελεί ο `authenticated` και έχει `p_business_id`, κλήση ως μέλος της Α (owner σε `aal2` με φρέσκο κωδικό, και staff) με το id της Β και `NULL` στα υπόλοιπα ορίσματα → `42501`. Ένα assertion ελέγχει ότι βρέθηκαν τουλάχιστον όσες functions περιμένουμε· το ελάχιστο ανεβαίνει σε κάθε βήμα.

**Κείμενα (κανόνας 8)**

- Όλα τα κείμενα του UI μέσω i18n, ανά namespace. Εξαιρέσεις θέσης, γραμμένες και στον κανόνα 8 του CLAUDE.md: `sms-templates.ts` (υπάρχει), `push-templates.ts` (από το 1.1 για το `spike-push`, ADR-0010) και `security-email-templates.ts` (1.9, C6), el/en με test el = en· το στατικό δίγλωσσο πρότυπο του email σύνδεσης (ADR-0009 §6).
- Open Graph και κείμενα ημερολογίου (Google Calendar, .ics) από το namespace `booking`. Ο Worker δεν έχει δικά του κείμενα: για άγνωστο slug επιστρέφει το κέλυφος της SPA με status 404.
- Κωδικοί σφαλμάτων τομέα (`AN0xx`, π.χ. `AN001 slot_taken`) στο `_shared/errors.ts`, με test ότι κάθε κωδικός έχει κλειδί i18n.

**Περιβάλλον και deploy**

- **Ποτέ `supabase config push`.** Το `config.toml` ισχύει μόνο τοπικά· οι ρυθμίσεις Auth του remote μπαίνουν με το χέρι από τη λίστα του `docs/SETUP.md`. Το `verify_jwt` ανά function μένει στο `[functions.<name>]` (το διαβάζει το `functions deploy`).
- Τα `dist/**/*.map` σβήνονται μετά το build και πριν από κάθε `wrangler deploy`, από το 1.1 (δεύτερη ασφάλεια: `public/.assetsignore` με `*.map`, που το Vite αντιγράφει στο `dist/`· ένα `.assetsignore` στη ρίζα δεν μετρά, και το `dist/` αδειάζει σε κάθε build). Το `deploy:dev` αποτυγχάνει αν βρει `.map`.
- Σειρά deploy: **migration → Edge Functions → Worker** (`scripts/deploy-dev.mjs`, που ελέγχει πρώτα το συνδεδεμένο project). Τα μυστικά του Worker είναι Worker secrets, ποτέ στο bundle.
- Στο `supabase/functions/_shared/` μόνο καθαρή λογική χωρίς `Deno`/`npm:` (ADR-0002 §3)· οι ρυθμίσεις περνούν ως ορίσματα: `requireProxy(req, secret)` στο `_shared/http.ts`, `createSmsProvider({ env, allowedRecipients, testNumbers })` στο `_shared/sms-provider.ts`, μόνο ο scrubber στο `_shared/observability.ts`. Το `Deno.env.get(…)` και το SDK του Sentry για Deno μένουν στο `index.ts` κάθε function (τα ελέγχει το `fn:check`).

**Checklist τέλους βήματος**

1. `typecheck`, `lint`, `test`, `e2e`· από το 1.1 και `fn:check`· από το 1.2 και `test:race`.
2. Αν άλλαξε η βάση: `db:reset`, `db:test`, `check:types`. Αν άλλαξαν η σελίδα κράτησης, ρυθμίσεις ή εξαρτήσεις: `build` και `size`.
3. Ο Μιχάλης: `db:push` → `secrets:dev` → `db:test:dev` → `deploy:dev`· μετά από `db:reset:dev`: `secrets:dev` → `provision:dev` → `db:test:dev` → `deploy:dev`.
4. ADR, `SETUP.md` και CLAUDE.md όπου άλλαξε κανόνας· SPEC §7 για νέους πίνακες· μια γραμμή κατάστασης στο SPEC §14.

## Προαπαιτούμενα

Τι κάνει ο Μιχάλης και πότε:

| Πότε                   | Τι                                                                                                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Μέρα 1, **βήμα 0**     | `npm run db:reset:dev` + `npm run db:test:dev` (141/141), πριν από οτιδήποτε άλλο: η διόρθωση του guard συναινέσεων δεν έχει φτάσει ακόμη στο `anaklo-dev`.                                                                                                                                |
| Μέρα 1                 | Επιβεβαίωση κατοχύρωσης του anaklo.gr. Λογαριασμός Cloudflare στο mailbox της Nous με 2FA, ζώνη `anaklo.gr` με nameservers στο Cloudflare, API token για το wrangler (Workers + DNS της ζώνης) στο password manager.                                                                       |
| Μέρα 1                 | Resend (περιοχή EU): επαλήθευση του `mail.anaklo.gr` με SPF, DKIM και DMARC· API key στο password manager.                                                                                                                                                                                 |
| Μέρα 1                 | SMS (D3): αιτήσεις για 2–3 δοκιμαστικούς λογαριασμούς στο όνομα του Μιχάλη, γραπτή ερώτηση σε κάθε πάροχο για τα 4 κριτήρια του C4, έναρξη καταχώρισης sender ID (θέλει χρόνο).                                                                                                            |
| Μέρα 2                 | OneSignal (mailbox της Nous, 2FA): Web app για `https://dev.anaklo.gr`, custom service worker `/app/sw.js`, scope `/app/`, Identity Verification **κλειστό** (υποστηρίζει μόνο τα mobile SDKs· ADR-0010 §2)· app id και κλειδί REST στο password manager. |
| Μέρα 2                 | iPhone με iOS ≥ 16.4 (ιδανικά 17+) και ένα Android, με Instagram και Facebook συνδεδεμένα. Στο iPhone η PWA θα εγκατασταθεί **στην αρχική οθόνη** για τη δοκιμή push (C5).                                                                                                                 |
| Μέρα 3                 | Dashboard του `anaklo-dev` με τη λίστα του `SETUP.md` (παρακάτω), αφού επαληθευτεί το domain στο Resend.                                                                                                                                                                                   |
| Μέρα 3                 | `npm run secrets:dev` (Edge Functions, Worker, Vault) από το password manager (`PROXY_SECRET`, `OTP_HMAC_KEY` και `PHONE_HMAC_KEY` στο Vault ως `otp_hmac_key`/`phone_hmac_key`, με `supabase link` στο dev· OneSignal: app id και κλειδί REST· Resend· αργότερα dispatch και πάροχος SMS) και μετά `npm run provision:dev` με το JSON από φάκελο **εκτός** repo (επιχείρηση demo, emails δοκιμαστικών λογαριασμών). |
| Μέρες 3–5              | Δοκιμές σε συσκευές του 1.1: εγκατάσταση της PWA στην αρχική οθόνη, άδεια push μέσα από την εγκατεστημένη εφαρμογή, cookie στους in-app browsers.                                                                                                                                          |
| Μέρες ~5–10            | SIM σε Cosmote, Vodafone και Nova (αρκούν καρτοκινητά) για τον πίνακα του 1.5b.                                                                                                                                                                                                            |
| Μέρα ~8                | Έλεγχος 3 ημερών: η εγκατεστημένη PWA είναι ακόμη συνδεδεμένη.                                                                                                                                                                                                                             |
| Μέρα ~12               | Επιλογή παρόχου SMS με τα κριτήρια C4 → σύμβαση, DPA, τελικό sender ID, προπληρωμή ή σκληρό όριο δαπάνης.                                                                                                                                                                                  |
| Πριν το 1.7 (μέρα ~27) | Εφαρμογή κωδικών στο iPhone (Google Authenticator, Microsoft Authenticator ή οι ενσωματωμένοι «Κωδικοί») και εφαρμογή κωδικών σε δεύτερη συσκευή (π.χ. το Android), για τη δοκιμή της δεύτερης συσκευής. Στοιχεία επικοινωνίας της Nous (email, τηλέφωνο) για την οθόνη «Χάσατε τη συσκευή σας;». Έγκριση του runbook `mfa-reset.md` (επαλήθευση ταυτότητας). |
| Μέρα ~28 (1η του 1.7)  | `npm run db:test:dev` για τον έλεγχο trigger στο `auth.mfa_factors` (C6, βλ. 1.7). Στο τέλος του 1.7, ο έλεγχος του `amr` και με το χέρι στο `dev.anaklo.gr`.                                                                                                                              |
| Πριν το 1.9 (μέρα ~34) | Sentry (EU): projects `booking`, `pro`, `functions` και auth token για source maps. Λογαριασμός uptime monitor (δωρεάν). Έγκριση των κειμένων των email ασφαλείας (el/en: μη εγκεκριμένη αλλαγή συσκευής κωδικών)· το κλειδί Resend φτάνει και στο `dispatch` με το `secrets:dev`. |
| Τέλος κάθε βήματος     | `npm run db:push` → `npm run secrets:dev` → `npm run db:test:dev` → `npm run deploy:dev`. Μετά από `db:reset:dev`: `secrets:dev` → `provision:dev` → `db:test:dev` → `deploy:dev`.                                                                                                        |

**Λίστα Auth στο dashboard του `anaklo-dev`** (γράφεται στο `docs/SETUP.md`· ποτέ `config push`):

- «Allow new users to sign up» = **off** (έγινε ήδη, μόνο επιβεβαίωση)
- MFA: **TOTP** enroll και verify ενεργά
- Email OTP: μήκος **6**, λήξη **600 s**
- Site URL `https://dev.anaklo.gr/app/`· redirect URLs `https://dev.anaklo.gr/app/**` και `http://localhost:5173/app/`
- Custom SMTP = Resend (`smtp.resend.com`, θύρα 465, αποστολέας στο `mail.anaklo.gr`)
- Πρότυπο «Magic Link» → πρότυπο κωδικού (`{{ .Token }}`, χωρίς link) από το `supabase/templates/`
- Όριο emails του Auth: π.χ. 30 την ώρα
- Sessions: JWT expiry **3600 s**, refresh token rotation **ενεργό** (προεπιλογές, μόνο επιβεβαίωση)
- Μόνο στο prod (Supabase Pro, Φάση 3): «Inactivity timeout» = **720h** (30 μέρες), «Time-box user sessions» κενό (κανένα απόλυτο όριο). Το Free του `anaklo-dev` δεν τα έχει· εκεί ισχύει μόνο ο έλεγχος της εφαρμογής (1.1)

## 1.1 Υποδομή

- **Στόχος:** Το `dev.anaklo.gr` σερβίρεται από έναν Cloudflare Worker (σελίδα κράτησης, `/app`, `/api` proxy που κρατά το cookie της έμπιστης συσκευής). Ο κουρέας εγκαθιστά το `/app` στο iPhone και συνδέεται μέσα στην εγκατεστημένη εφαρμογή με κωδικό email. Οι Edge Functions ελέγχονται στο CI, το provisioning στήνει την επιχείρηση demo, και οι δοκιμές σε συσκευές κλείνουν cookies, session και push πριν τα χρειαστεί άλλο βήμα.
- **Μέρες:** 5
- **Εξαρτάται από:** το βήμα 0 (remote dev ενημερωμένο).

**Βάση**

- Κανένα migration. `supabase/seed.sql`: συνθετικοί χρήστες Auth (owner, manager, staff, και ένας χωρίς συμμετοχή για το «χωρίς πρόσβαση»), emails `*.test`, με σταθερά UUID, `email_confirmed_at`, `aud` = `role` = `authenticated`, **κενά strings** (όχι `NULL`) στα `confirmation_token`, `recovery_token`, `email_change_token_new`, `email_change` (αλλιώς το GoTrue απαντά 500), γραμμή στο `auth.identities` (provider `email`) και `on conflict do nothing`. Μετά `business_members` για το `demo-barber`. Δεν γράφουν ραντεβού, άρα δεν χρειάζονται actor.
- `supabase/config.toml`, μόνο τοπικά: `otp_expiry = 600` (το `otp_length = 6` υπάρχει)· `site_url` και redirects· πρότυπο κωδικού στο `supabase/templates/`· τοπικό `[auth.rate_limit] email_sent` από 2 σε π.χ. 100· `[auth] jwt_expiry = 3600` και `enable_refresh_token_rotation = true` (επιβεβαίωση)· `[auth.sessions] inactivity_timeout = "720h"`· `[edge_runtime.secrets] PROXY_SECRET = "env(PROXY_SECRET)"`, γιατί το edge runtime δεν διαβάζει το `.env.local`.
- `verify_jwt = false` σε κάθε function που δεν καλείται με JWT χρήστη: `health`, `spike-td`, `public-booking`, `manage` (publishable key μέσω του proxy· τα `sb_publishable_` δεν είναι JWT), `dispatch` (μυστικό από Vault, pg_net), `sms-dlr` (υπογραφή ή μυστικό του παρόχου). Ο έλεγχος γίνεται στον κώδικα. `verify_jwt = true` μόνο στο `spike-push`, στο `invite-member` και στο `manage-factors` (1.7), που τα καλεί η PWA απευθείας με το JWT του χρήστη.
- `scripts/provision-business.mjs` (`npm run provision:dev`): JSON από φάκελο εκτός repo, με Zod (στο repo μόνο το συνθετικό `supabase/provision/demo-barber.example.json`). **Δημιουργεί** την επιχείρηση· για υπάρχον slug ενημερώνει μόνο στήλες που αλλάζει και η εφαρμογή. Τα `slug`, `timezone`, `currency` μπαίνουν μόνο στη δημιουργία (μετά μόνο με το `change_business_identity` του 1.7)· το `vertical` μόνο στη δημιουργία, και δεν αλλάζει στη Φάση 1.
- Το ίδιο script γράφει προσωπικό (και χωρίς login), κατηγορίες, υπηρεσίες, `staff_services`, ωράρια (Zod χωρίς επικαλύψεις, delete-then-insert), χρήστες Auth με admin API (`email_confirm`, χωρίς link) και μέλη. Αρνείται project άλλο από το `SUPABASE_DEV_PROJECT_REF` χωρίς `--prod` και δεν γράφει ποτέ ραντεβού. Ως `service_role` παρακάμπτει τις πολιτικές `aal2`: είναι εργαλείο της Nous, όχι της εφαρμογής.

**Edge Functions**

- Toolchain: `deno` ως pinned npm devDependency· scripts `fn:check` (deno check + lint), `fn:serve`, `fn:deploy:dev`. Το CI τρέχει `fn:check`.
- CI (`.github/workflows/ci.yml`), job `database-e2e`: το `supabase start -x` γίνεται `-x studio,imgproxy,logflare,vector,supavisor`, δηλαδή **χωρίς** `edge-runtime` και `mailpit` (χωρίς Mailpit δεν φτάνει ο κωδικός email, χωρίς edge runtime αποτυγχάνει κάθε `/api/functions/v1/*`). Τα `PROXY_SECRET` και `APP_ENV=local` μπαίνουν ως env του job, για τον Vite και για το edge runtime (μέσω του `[edge_runtime.secrets]`). Ίδιες μεταβλητές στο `.env.example` και στο `docs/SETUP.md` §3 (το `e2e` τις θέλει στο `.env.local`).
- `_shared/http.ts` (για τις functions πίσω από το `/api`: `health`, `spike-td`, `public-booking`, `manage`): `requireProxy(req, secret)` ελέγχει το `x-anaklo-proxy-secret` σε σταθερό χρόνο, και δίνει 500 χωρίς να δεχτεί ποτέ το αίτημα όταν το μυστικό που του περνά το `index.ts` (από το `PROXY_SECRET` του env) λείπει ή είναι κενό· IP μόνο από `x-anaklo-client-ip`· είσοδος με `zod/mini`· ενιαίο σχήμα σφάλματος· `Cache-Control: no-store`. Τα `dispatch`, `sms-dlr`, `invite-member` και `manage-factors` δεν περνούν από το `/api` και έχουν δικό τους έλεγχο.
- `health` (χωρίς δεδομένα: αποδεικνύει deploy, μυστικό και περιοχή) και `spike-td` (προσωρινή: εκδίδει και διαβάζει token μέσω του Worker, σβήνεται στο τέλος του βήματος).
- Όριο σώματος 64 KB (`_shared/body-limit.ts`, ίδιο στον proxy και στο `parseJsonBody`): μετρά το stream και το κόβει μόλις περάσει το όριο, και χωρίς `Content-Length` (chunked, HTTP/2)· μη αριθμητικό `Content-Length` → 400.
- `spike-push` (προσωρινή, `verify_jwt = true`, για τη δοκιμή C5 του ADR-0010 §3): μόνο για owner (ρόλος από το `business_members`)· σώμα `{ subscription_id }` (UUID, `zod/mini`), δηλαδή η συνδρομή που διάβασε η εφαρμογή από το SDK της **δικής της** συσκευής· στέλνει δοκιμαστικό push **μόνο** σε αυτή (`POST https://api.onesignal.com/notifications?c=push`, `target_channel: 'push'`, `include_subscription_ids`, κλειδί REST ως secret). Κανένα `external_id`, κανένας πίνακας και κανένα migration στο 1.1 (ADR-0010 §2). Το payload το χτίζει το καθαρό `buildPushPayload` του `_shared/onesignal.ts`, που το ξαναχρησιμοποιεί το `dispatch` στο 1.5a. Σε no-go, η ίδια function στέλνει Web Push (VAPID) για την επανάληψη της δοκιμής, και ο χρόνος χρεώνεται στο buffer. Σβήνεται όταν κλείσει η δοκιμή, το αργότερο στο 1.5a, όπου τη θέση του παίρνει το `dispatch`.

**Frontend (και Worker)**

- Worker στο `edge/` (wrangler, νέο devDependency): static assets· `/app/*` → `app/index.html`· `/m/*` με `Referrer-Policy: no-referrer` και `Cache-Control: no-store` (ADR-0008 §2). Ρυθμίσεις wrangler: `assets.html_handling = "none"` (αλλιώς το fetch του `/index.html` δίνει 307 αντί για το κέλυφος) και `not_found_handling` στο `none` (αλλιώς οι navigations χωρίς asset δεν περνούν από τον Worker)· smoke test: το `/demo-barber` δίνει 200 HTML, όχι 307.
- `/api/*` proxy: μόνο διαδρομές από allow-list (ονομαστικές RPCs και functions), με άγκυρα στο `/api/` (το `/api-barber` δεν περνά)· αφαιρεί τα `x-anaklo-*` του client (αφού διαβάσει το `x-anaklo-business`), τα `x-forwarded-*`, το `x-real-ip` και το `Cookie`· προσθέτει μυστικό proxy, `x-anaklo-client-ip` από το `CF-Connecting-IP`, `x-region` της βάσης και το publishable key· `Cache-Control: no-store`.
- Cookie έμπιστης συσκευής **μόνο** στον Worker: η σελίδα κράτησης δηλώνει την επιχείρηση στο header `x-anaklo-business`. Ο Worker το διαβάζει (έλεγχος μορφής UUID) **πριν** αφαιρέσει τα `x-anaklo-*` του client, προωθεί **μόνο** το cookie `__Host-td_<αυτό το id>` ως `x-anaklo-td` και ξαναβάζει το ίδιο `x-anaklo-business`. Η Edge Function δέχεται το token μόνο αν η επιχείρηση του header είναι αυτή του σώματος. Το header απάντησης `x-anaklo-set-td` γίνεται `__Host-td_<business_id>` (`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=15552000`) και αφαιρείται. Μόνο όταν `APP_ENV=local` (`http://localhost`) το cookie γράφεται ως `td_<business_id>` **χωρίς** `Secure` (το `__Host-` απαιτεί `Secure`, και το WebKit δεν κρατά `Secure` cookie σε http). Για κάθε άλλη τιμή του `APP_ENV`, ή αν λείπει, ισχύουν `__Host-` και `Secure`.
- Τα ίδια modules και η έγχυση του `/<slug>` (`edge/inject.ts`, καθαρή συνάρτηση σε string) τρέχουν και ως middleware του Vite, ώστε το Playwright να περνά από τον ίδιο δρόμο. Η έγχυση παίρνει τα δεδομένα από το `public_business_profile` (Φάση 0) στο 1.1 και από το `public_booking_catalogue` από το 1.3. Το μυστικό τοπικά από μεταβλητή χωρίς `VITE_` στο `.env.local`.
- PWA: `/app/login` (email → κωδικός 6 ψηφίων). **Το ίδιο ουδέτερο μήνυμα** για `otp_disabled` (άγνωστο email, με κλειστό signup) **και** για `over_email_send_rate_limit` (όριο ανά διεύθυνση)· διαφορετικό μήνυμα μόνο για σφάλμα δικτύου και για το όριο ανά IP (`over_request_rate_limit`). Το email σε αναμονή μένει στο `localStorage` με λήξη, για την περίπτωση που το iOS κλείσει την εφαρμογή όσο ο χρήστης διαβάζει το Mail. Loaders `requireSession`/`requireMembership` (ο ρόλος διαβάζεται πάντα από το `business_members`, ποτέ από το JWT), οθόνη «χωρίς πρόσβαση».
- Πολιτική session (ADR-0009): access token 1 ώρα και rotation των refresh tokens (ρυθμίσεις Auth). **30 μέρες αδράνειας** → τέλος session και πλήρης σύνδεση. Επειδή το Free του `anaklo-dev` δεν έχει «Inactivity timeout», την επιβάλλει και η εφαρμογή: timestamp τελευταίας δραστηριότητας στο `localStorage`, που ενημερώνεται σε κάθε άνοιγμα και focus. Ο έλεγχος τρέχει πριν από κάθε ενημέρωση (στο `requireSession` και στο focus): αν έχουν περάσει > 30 μέρες, καλείται η ίδια συνάρτηση αποσύνδεσης με την επόμενη γραμμή (`signOut({ scope: 'local' })` και `OneSignal.User.PushSubscription.optOut()`) → login. Το ίδιο γίνεται όταν το supabase-js στείλει `SIGNED_OUT` επειδή το session ανακλήθηκε (αλλαγή ρόλου, αφαίρεση, «από όλες τις συσκευές»· ADR-0010 §2). Καθαρή συνάρτηση `isSessionStale(lastActivityAt, now)` με Vitest. Κανένα απόλυτο όριο διάρκειας.
- Αποσύνδεση: `signOut({ scope: 'local' })`, μόνο αυτή η συσκευή, γιατί τα κινητά του μαγαζιού είναι κοινά· και πριν από αυτό `OneSignal.User.PushSubscription.optOut()` (από το 1.5a και `unregister_push_subscription`), με ανώτατο χρόνο, ώστε το push να μη μπλοκάρει ποτέ την αποσύνδεση. Η ίδια συνάρτηση δέχεται `scope: 'global'` για την «Αποσύνδεση από όλες τις συσκευές» (Ρυθμίσεις → Ασφάλεια, 1.7). Μετά από αποσύνδεση, η επόμενη είσοδος είναι **νέα** σύνδεση (από το 1.7 και με κωδικό από την εφαρμογή κωδικών για owner/manager).
- iOS Safari εκτός standalone: οθόνη «Πρόσθεσε πρώτα στην αρχική οθόνη». Την απόφαση την παίρνει καθαρή συνάρτηση `needsInstall({ isIOS, standalone })`, με Vitest. Στο Playwright, για το project `mobile-safari` (`devices['iPhone 14']`, χωρίς `navigator.standalone`), ένα `addInitScript` ορίζει `navigator.standalone = true`, και ένα spec χωρίς αυτό ελέγχει ότι η οθόνη εμφανίζεται. Εικονίδια PNG (apple-touch-icon 180 px, manifest 192/512 maskable). `/app/sw.js`: μόνο import του worker του OneSignal (scope `/app/`), χωρίς caching.
- Προσωρινό κουμπί «Ενεργοποίηση ειδοποιήσεων» στην `/app`, για τη δοκιμή του ADR-0010 §3 (κείμενα μέσω i18n): lazy SDK του OneSignal με `serviceWorkerPath: 'app/sw.js'` και scope `/app/`, **χωρίς** `OneSignal.login` (καμία ταυτότητα στον client, ADR-0010 §2)· αίτημα άδειας **μόνο** μέσα στο handler του πατήματος, και στο iOS μόνο σε standalone, μετά `optIn()` και ανάγνωση του `PushSubscription.id` (αν είναι `null`, αναμονή για το event `change`, με όριο χρόνου)· `optOut()` στην αποσύνδεση· μια αποσύνδεση όσο φορτώνει το SDK ή όσο τρέχει η ενεργοποίηση την ακυρώνει και κάνει `optOut`. Δίπλα (μόνο για owner), κουμπί «Δοκιμαστικό push» που καλεί το `spike-push` με το `subscription_id` αυτής της συσκευής (μέσω του `api.ts`). Η κανονική οθόνη έρχεται στο 1.5a.
- Scripts: `deploy-dev.mjs` (migration → functions → build → σβήσιμο `.map` → Worker· idempotent· **ποτέ** ρυθμίσεις Auth) και `secrets-dev.mjs`: idempotent, Vault με create ή update ανά όνομα (ένα `DO` μέσω `supabase db query --linked --file`, μόνο με `supabase link` στο dev, χωρίς τιμές στη γραμμή εντολών), `supabase secrets set` για τις functions και `wrangler secret put` για τον Worker (το `PROXY_SECRET` με την ίδια τιμή σε Worker και functions)· από env, ποτέ από το repo.
- Έγγραφα: ADR-0008 (hosting, proxy, cookie), ADR-0009 (κωδικός email, κλειστό signup, provisioning, εξαίρεση κανόνα 8 για το email, πολιτική session, σχέδιο TOTP του C3), ADR-0010 (push, προτεινόμενο)· λίστα dashboard στο `SETUP.md`· `edge/` στη «Δομή» του CLAUDE.md.

**Tests**

- Vitest `edge/api-proxy.test.ts` (το `include` του `vitest.config.ts` αποκτά `edge/**/*.test.ts`, αλλιώς τα tests δεν τρέχουν): αφαιρεί ψεύτικα `X-Forwarded-For`/`x-anaklo-*`/`x-real-ip`· το `Cookie` δεν φτάνει στο Supabase· το `x-anaklo-business` επιλέγει cookie, και με τιμή που δεν είναι UUID δεν προωθείται τίποτα· απορρίπτει διαδρομές εκτός λίστας και το `/api-barber`· `no-store` παντού· round trip cookie ⇄ header με ακριβή attributes· όνομα **και attributes** του cookie ανά `APP_ENV` (και χωρίς `APP_ENV` → `__Host-` και `Secure`). Vitest `_shared/http.test.ts`: χωρίς ή με λάθος μυστικό → 403· κενό μυστικό ως όρισμα → 500, ποτέ δεκτό· IP μόνο από το header του proxy.
- Vitest: `needsInstall`, `isSessionStale` (29 και 31 μέρες), αντιστοίχιση σφαλμάτων του `signInWithOtp` σε μήνυμα (επιτυχία, `otp_disabled` και `over_email_send_rate_limit` → ίδιο ουδέτερο μήνυμα· διαφορετικό μόνο για δίκτυο και `over_request_rate_limit`), αποσύνδεση με `scope: 'local'` από προεπιλογή· αποτυχημένη επαναποστολή κωδικού κρατά το email σε αναμονή όπως ήταν· αποσύνδεση όσο φορτώνει το SDK ή όσο τρέχει η ενεργοποίηση του push → κανένα `optIn` μετά από αυτήν, ένα `optOut`, με ανώτατο χρόνο· ποτέ `login`/`logout` του OneSignal (`oneSignal.test.ts`)· payload του push μόνο με `include_subscription_ids` και `target_channel: 'push'`, el και en, κανένα `external_id`/`include_aliases` (`_shared/onesignal.test.ts`)· σώμα χωρίς `Content-Length` κόβεται στο όριο (`body-limit`, proxy, `parseJsonBody`)· provisioning: σειρά εγγραφών μελών (παράδοση ιδιοκτησίας, μετακίνηση προσωπικού σε νέο login) και έλεγχος συνδέσεων προσωπικού στην τελική κατάσταση· SQL του Vault (`vaultUpsertSql`).
- Playwright `pro-login.spec`: ο owner συνδέεται με κωδικό email (από το Mailpit, αφού αφαιρεθεί το `mailpit` από το `-x` του CI)· μη μέλος → «χωρίς πρόσβαση»· άγνωστο email → ίδιο μήνυμα· `mobile-safari` χωρίς standalone → οθόνη εγκατάστασης. Στο 1.7 το spec ενημερώνεται (ο owner καταλήγει σε `enroll`/`challenge`).

**Δοκιμές σε συσκευές** (go/no-go για καθεμία):

| Δοκιμή                     | Πού                                                          | Περνά όταν                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cookie έμπιστης συσκευής   | Instagram και Facebook in-app (iOS, Android), Safari, Chrome | γράφεται, διαβάζεται και υπάρχει μετά από επανεκκίνηση της εφαρμογής                                                                                 |
| Session εγκατεστημένης PWA | iPhone, εφαρμογή στην αρχική οθόνη                           | σύνδεση μέσα στην εφαρμογή· μένει συνδεδεμένη μετά από kill και μετά από 3 μέρες                                                                     |
| Push (C5)                  | iPhone, iOS ≥ 16.4, PWA **εγκατεστημένη στην αρχική οθόνη**  | όλα τα βήματα του ADR-0010 §3: η άδεια ζητείται μέσα από την εγκατεστημένη εφαρμογή με πάτημα κουμπιού· το «Δοκιμαστικό push» (`spike-push`) φτάνει στη συσκευή· push στη συνδρομή της συσκευής (από το dashboard του OneSignal) φτάνει με την εφαρμογή κλειστή και την οθόνη κλειδωμένη· το πάτημα ανοίγει την εφαρμογή στη σωστή οθόνη· το ίδιο μετά από επανεκκίνηση του κινητού και μετά από 24 ώρες· μετά την αποσύνδεση (`optOut`) δεν φτάνει τίποτα· ο `/app/sw.js` δεν χαλά φόρτωση και ενημέρωση· κανείς δεν παίρνει τα push άλλου: το push του owner δεν φτάνει στον browser ενός `staff`, και δεν υπάρχει ταυτότητα στον client για να την υποδυθεί (βήμα 10) |
| Push                       | Android Chrome, εγκατεστημένη PWA                            | όπως στο iPhone                                                                                                                                      |

Το αποτέλεσμα του push γράφεται στο ADR-0010: go → OneSignal (αποδεκτό), no-go → VAPID. Ο έλεγχος των 3 ημερών κλείνει γύρω στη μέρα 8 και γράφεται στο ADR-0009, στην ενότητα «Αποτέλεσμα δοκιμής».

**Κριτήρια εξόδου**

- `dev.anaklo.gr/demo-barber` και `/app` από τον Worker· το `/api/functions/v1/health` δίνει 200 μέσω proxy και 403 απευθείας.
- Σε πραγματικό iPhone: εγκατάσταση, σύνδεση μέσα στην standalone εφαρμογή, kill, και παραμένει συνδεδεμένο. Go/no-go για το push στο ADR-0010 (C5).
- `npm run deploy:dev` idempotent, χωρίς κανένα `.map`· CI πράσινο με `fn:check`. ADR-0008/0009/0010 γραμμένα· λίστα dashboard στο `SETUP.md` και εφαρμοσμένη στο `anaklo-dev`.
- Οι αιτήσεις για λογαριασμούς SMS και sender ID τρέχουν (παρακολουθείται, δεν μπλοκάρει).

## 1.2 Διαθεσιμότητα και κράτηση σε SQL

- **Στόχος:** Σωστά slots και ατομικές κρατήσεις για τη δημόσια σελίδα και το προσωπικό, σε αλλαγές ώρας, τοπικά μεσάνυχτα, κλεισίματα και ταυτόχρονα αιτήματα. Η λογική ζει μόνο σε SQL, με pgTAP. Δεν θέλει εξωτερικό λογαριασμό, άρα προχωρά όσο εκκρεμούν αιτήσεις.
- **Μέρες:** 4,5
- **Εξαρτάται από:** — (0001–0003).

**Βάση: `0004_availability_booking.sql`**

- `businesses.address` και `maps_url` (μόνο `https://`), με `grant update (address, maps_url)` στο `authenticated` και στη λίστα στηλών του `01_security`. Τα `slug`, `timezone`, `currency`, `vertical` είναι ήδη εκτός GRANT (0001). Καμία νέα στήλη επαλήθευσης: τα `verified_via` και `appointments_online_verified` υπάρχουν (0003). Index `(business_id, staff_id, starts_at)` για `booked`/`confirmed`.
- `private.service_terms`: διάρκεια και τιμή ανά επαγγελματία (custom ή προεπιλογή)· buffer της τελευταίας υπηρεσίας.
- `private.staff_day_windows`: εξαίρεση επαγγελματία, μετά μαγαζιού, μετά εβδομαδιαίο ωράριο· ένωση όλων των `open` διαστημάτων του εύρους που κερδίζει (ένα `closed` είναι πάντα μόνο του)· τοπικό → UTC μία φορά ανά ημερομηνία (`AT TIME ZONE`)· μείον τις άδειες.
- `private.available_slots_impl(p_business_id, p_service_ids uuid[], p_staff_id, p_from date, p_to date, p_mode, p_exclude_appointment_id, p_now timestamptz default now())`: αφαιρεί τα `booked`/`confirmed` **μαζί με τα buffers**· τοπικό πλέγμα (λεπτό % `slot_step_min` = 0) όπου χωρά διάρκεια + buffer· σε `public` ισχύουν `min_notice`, `max_advance`, `online_bookable`, `active`, `booking_enabled`, σε `staff` όχι· έως 14 μέρες ανά κλήση· «οποιοσδήποτε» = ένωση χωρίς διπλά.
- `private.book_core` (χωρίς GRANT):
  - advisory lock με `pg_advisory_xact_lock(hashtextextended(p_business_id::text || ':' || v_local_date::text, 0))` (στο `move_core` και οι δύο μέρες, με σταθερή σειρά)· επανέλεγχος με το `available_slots_impl` (σε `public` πάντα με buffers)
  - idempotency: ίδιο κλειδί και payload → ίδια γραμμή· ίδιο κλειδί με άλλο payload → σφάλμα
  - «οποιοσδήποτε»: τα λιγότερα κλεισμένα λεπτά της ημέρας, μετά `sort`, μετά `id`· τιμή και διάρκεια από τον server στο `appointment_services`
  - πελάτης: υπάρχον id ελεγμένο ως προς την επιχείρηση (και το τηλέφωνο στην online), ή νέος· **ποτέ upsert με τηλέφωνο**
  - `verified_via` μόνο σε `public` (υποχρεωτικό όρισμα), `NULL` αλλιώς· `23P01` → `AN001 slot_taken`· καλεί `private.plan_messages_impl(id, 'created')`
- Λειτουργία προσωπικού (D8): ώρα εκτός ωραρίου και επικάλυψη με **buffer** άλλου ραντεβού μόνο με ρητό flag, με προειδοποίηση στην απάντηση· **ποτέ** επικάλυψη με χρόνο υπηρεσίας. Το `appointments_no_overlap` μένει χωρίς `blocked_until`.
- `private.move_core(appointment, νέα ώρα, νέος επαγγελματίας, mode, flags, p_now)`: κλειδώνει και τις δύο τοπικές μέρες με σταθερή σειρά, ξαναελέγχει χωρίς το ίδιο το ραντεβού, κάνει update στη θέση του (ο υπάρχων trigger γράφει `rescheduled`/`reassigned`) και καλεί τον planner. Κοινό για πελάτη (1.3) και προσωπικό (1.4).
- `private.plan_messages_impl(p_appointment_id uuid, p_change text)`: κενό σώμα (βλ. Κανόνες).
- Wrappers (SECURITY INVOKER, ρητό GRANT): για `anon` τα `public_booking_catalogue(p_slug)` (jsonb, μόνο δημόσια πεδία, μόνο με `booking_enabled`) και `available_slots(p_slug, …)`· για `authenticated` τα `staff_available_slots(p_business_id, …)` και `staff_book_appointment(p_business_id, …)`, με νέο πελάτη inline ή κανέναν (walk-in) σε ένα round trip, χωρίς δήλωση actor (→ `staff`).
- Το `p_now` υπάρχει μόνο στα `_impl` (για τα tests). Κανένα wrapper του `public` δεν το δέχεται: περνούν `now()`. Assertion στο `01_security`: καμία function του `public` δεν έχει παράμετρο `p_now`.
- `01_security`: allow-lists `anon`/`authenticated` και νέα ρητή λίστα `service_role`. `supabase/snippets/perf-fixture.sql`: 5.000 ραντεβού μέσα σε **ένα** `DO` block που πρώτα δηλώνει `system` (το setting ισχύει ανά transaction).

**Edge Functions:** καμία· η σελίδα φτάνει στις RPCs μέσω του allow-list του Worker. **Frontend:** μόνο οι νέοι τύποι βάσης.

**Tests**

- pgTAP `08_availability` (σταθερό `p_now`):
  - πλέγμα: σπαστό ωράριο· πλέγμα 15′ και 20′· χωρά διάρκεια + buffer· custom διάρκεια και τιμή
  - κλεισίματα: μαγαζί κλειστό· `open` επαγγελματία πάνω από κλείσιμο μαγαζιού· μισή μέρα· μερική άδεια· η αργία 2026-10-28 χωρίς slots
  - το buffer κλείνει το επόμενο slot, τα ακυρωμένα όχι· `min_notice`, `max_advance`· `online_bookable` μόνο σε `public`· ανενεργά αγνοούνται· «οποιοσδήποτε» χωρίς διπλά
  - ζώνες: 2026-03-29 (η χαμένη ώρα χωρίς slots) και 2026-10-25 (χωρίς διπλά) με νυχτερινή βάρδια 00:00–05:00· τοπικά 00:00–02:59 στη σωστή μέρα· δεύτερη επιχείρηση σε `America/New_York`· `booking_enabled = false` → τίποτα· εύρος > 14 ημερών → σφάλμα
- pgTAP `09_booking`:
  - ο επανέλεγχος απορρίπτει κλεισμένη ώρα· ίδιο κλειδί → 1 γραμμή και 1 event· ίδιο κλειδί με άλλο payload → σφάλμα· τιμή από τον client αγνοείται· ισοπαλία «οποιουδήποτε»
  - εκτός ωραρίου μόνο με flag· staff με flag μέσα σε buffer περνά, `public` στο ίδιο buffer απορρίπτεται· επικάλυψη υπηρεσίας ποτέ· walk-in χωρίς πελάτη· ποτέ συγχώνευση με τηλέφωνο
  - `verified_via` στην online, `NULL` σε staff, τηλέφωνο, walk-in (κράτηση staff με `verified_via` σκάει στο `appointments_online_verified`)· actor του event `client` online, `staff` στην εφαρμογή· staff της Β δεν κλείνει στην Α
- pgTAP `02_tenant_isolation`: ο γενικός βρόχος των Κανόνων.
- Νέο `npm run test:race` (Vitest με supabase-js μέσω HTTP στο τοπικό Supabase· σύνδεση με `auth.admin.generateLink` → `verifyOtp`, χωρίς email), σε χωριστό `vitest.db.config.ts` (π.χ. `tests/db/**`), εκτός του `npm test`, στο job βάσης του CI: 20 παράλληλες κρατήσεις στο ίδιο slot → 1 γραμμή και 19 `slot_taken`· 10 παράλληλες με ίδιο κλειδί → 1 γραμμή.

**Κριτήρια εξόδου**

- pgTAP πράσινο τοπικά και με `db:test:dev`· `check:types` και race test πράσινα στο CI.
- `EXPLAIN ANALYZE` στο dev: 14 μέρες × 3 επαγγελματίες πάνω σε 5.000 ραντεβού σε < 50 ms.

## 1.3 Online κράτηση end-to-end

- **Στόχος:** Στο `dev.anaklo.gr/demo-barber`, από Instagram και Facebook in-app: υπηρεσία → επαγγελματίας (μόνο με ≥ 2 και `allow_any_staff`) → ώρα → όνομα + κινητό, με κουτί άρνησης μάρκετινγκ → OTP μόνο σε νέα συσκευή → «Κλείνεις ως Γιώργος · άλλο άτομο» → επιβεβαίωση με link διαχείρισης, Google Calendar, .ics, χάρτη και πρόταση επόμενης επίσκεψης. Η ίδια συσκευή ξανακλείνει χωρίς OTP· το `/m/<token>` ακυρώνει ή μετακινεί. Τα SMS περνούν από τον ψεύτικο adapter ή τους δοκιμαστικούς αριθμούς του dev μέχρι το 1.5b.
- **Μέρες:** 6,5
- **Εξαρτάται από:** 1.1 (Worker, proxy, cookie, toolchain), 1.2 (0004).

**Βάση: `0005_public_booking.sql`**

- Νέοι πίνακες με RLS και χωρίς GRANT σε ρόλο του API (μόνο μέσω RPC):
  - `otp_challenges`: κωδικός ως HMAC (κλειδί Vault `otp_hmac_key`, από το `secrets:dev` ήδη από το 1.1), λήξη 5′, έως 5 προσπάθειες, 60″ ανάμεσα σε αποστολές· και `grant_hash`, `grant_expires_at`, `grant_used_at`
  - `trusted_devices`: sha256 του token (≥ 128 bit), ανά επιχείρηση και τηλέφωνο, 6 μήνες, ανακλήσιμο· `booking_tokens`: hash, ραντεβού, λήξη, ανάκληση, **πολλά ζωντανά ανά ραντεβού**· `rate_limits`: κλειδιά IP και τηλεφώνου ως HMAC
  - `messages_log` (outbox): μοναδικό `dedupe_key` (ραντεβού/πρότυπο/ώρα ή `otp_challenge`)· `channel` (`sms`, `push`)· `to_e164` ή `recipient_user_id`· `locale`, `template`, `category`· status `queued|sending|sent|delivered|failed|cancelled|unknown`· `attempts`, `lease_until`, `scheduled_for`, `sent_at`· `booking_token_id` (ποτέ το link)· `segments`, `cost_cents`, `provider`, `provider_message_id`, `error`
  - `suppression_list (business_id, phone_hmac, reason)` με `private.phone_hmac()` (HMAC-SHA256, κλειδί Vault `phone_hmac_key`, από το `secrets:dev` ήδη από το 1.1· στο 1.3 γίνονται υποχρεωτικά στο `secrets-plan.mjs`)· `private.platform_settings` (πλατφορμικός διακόπτης SMS, ημερήσιο όριο)
- `businesses.short_code` για το `/r/<code>` (6 χαρακτήρες `a-z0-9`, unique, προεπιλογή από τη βάση, χωρίς GRANT update) και RPC του `anon` `public_slug_for_code(p_code)` για τον Worker.
- `private.vertical_defaults` (barber: 28 μέρες), ίδιο με το νέο `packages/verticals/barber.json`. `private.next_visit_hint_impl(business)`: ο διάμεσος της επιχείρησης με ≥ 50 διαστήματα, αλλιώς η προεπιλογή του κλάδου· επιστρέφει κλειδί i18n και εβδομάδες· το ξαναχρησιμοποιεί η «μνήμη» (Φάση 2).
- RPCs μόνο για `service_role` (`private.*_impl` + wrapper):
  - `otp_start`: όρια ανά αριθμό, IP, επιχείρηση, ημέρα, πλατφορμικό όριο και διακόπτης· μόνο +3069· ζητά ώρα **ακόμη ελεύθερη** πριν από κάθε SMS· ίδια απάντηση για κάθε αριθμό
  - `otp_verify`: σωστός κωδικός της **ίδιας** επιχείρησης → grant (≥ 128 bit, hash στη βάση, ~10′, δεμένο σε επιχείρηση, τηλέφωνο και challenge)· `trusted_device_check`, `trusted_device_issue`
  - `clients_for_phone`: μόνο μικρά ονόματα, μόνο με έγκυρο grant ή έμπιστη συσκευή, χωρίς να καταναλώνει το grant
  - `book_appointment` (το wrapper της online κράτησης, μόνο `service_role`· D10): **πρώτα** idempotency: ίδιο κλειδί και ίδιο payload, με το ίδιο (ήδη καταναλωμένο) grant ή την ίδια έμπιστη συσκευή → το υπάρχον ραντεβού και **νέο** token, χωρίς νέα κατανάλωση. Μετά καταναλώνει το grant (εφάπαξ) ή ελέγχει την έμπιστη συσκευή· `book_core` με `verified_via` `otp`/`trusted_device` και actor `client`· `soft_opt_in` μόνο αν το κουτί εμφανίστηκε και έμεινε ατσεκάριστο, με `policy_version`· planner· νέο manage token που επιστρέφεται **μία** φορά
  - `phone_verified_at` μόνο στον δρόμο του OTP: `now()` σε νέο και σε υπάρχοντα πελάτη, και αν αλλάζει ο αριθμός, στο ίδιο UPDATE (έτσι το `reset_phone_verification` τον κρατά). Η έμπιστη συσκευή δεν τον γράφει
  - `manage_view` (δεν αλλάζει τίποτα), `manage_cancel`, `manage_reschedule` (`move_core` σε `public`), με actor `client`. Το `manage_cancel` σέβεται το `cancel_min_notice_min`, **εκτός** αν η κράτηση έγινε μέσα στο παράθυρο ειδοποίησης ή πριν από < 60′ (ADR-0006 §5), και ανακαλεί όλα τα tokens του ραντεβού
  - `claim_messages(p_ids)` και `record_send_result`: lease, και **νέο token για κάθε μήνυμα** με link διαχείρισης, που επιστρέφεται μόνο στον αποστολέα
- `plan_messages_impl`, σώμα v1: επιβεβαίωση online κράτησης (πάντα), ακύρωση και αλλαγή από τον πελάτη.
- `01_security`: λίστα `service_role` και assertion ότι κανένας ρόλος του API δεν έχει δικαίωμα στους νέους πίνακες.

**Edge Functions**

- `public-booking` (μόνο POST· `start`, `verify`, `clients`, `book`): έλεγχος μυστικού proxy, IP από τον Worker· schemas `zod/mini` από το `_shared/booking-schemas.ts`, κοινά με τη σελίδα· ίδια απάντηση για γνωστό και άγνωστο αριθμό· token έμπιστης συσκευής μόνο μέσω των headers του Worker, και μόνο αν το `x-anaklo-business` είναι η επιχείρηση του σώματος· grant στο σώμα της απάντησης· αν αποτύχει το OTP, επιστρέφει το τηλέφωνο της επιχείρησης.
- `manage`: view, cancel, reschedule, όλα με POST· τίποτα δεν αλλάζει με GET.
- `_shared/send.ts`: claim → `renderSms` στη γλώσσα του πελάτη → adapter → `record_send_result`, αμέσως μετά το commit (SPEC §12)· ο client της βάσης και ο adapter περνούν ως ορίσματα από το `index.ts`. Τον ίδιο κώδικα χρησιμοποιεί ο dispatcher του 1.5a.
- `_shared/sms-provider.ts`: interface, ψεύτικος adapter (γράφει αποτέλεσμα, δεν στέλνει) και `createSmsProvider({ env, allowedRecipients, testNumbers })`, με τις τιμές από το `Deno.env` του `index.ts`. Εκτός prod: `SMS_ALLOWED_RECIPIENTS` και `OTP_TEST_NUMBERS` (σταθερός κωδικός για το `+306900000xxx` του seed και τα κινητά του developer), που απορρίπτονται στην εκκίνηση όταν `ANAKLO_ENV=prod`.
- Νέο πρότυπο SMS `rescheduled_by_client`, με test 1 SMS.

**Frontend**

- `useBookingFlow`: καθαρός reducer (service → staff → slot → details → OTP αν χρειάζεται → client choice → confirm)· το grant μόνο στη μνήμη· μία υπηρεσία ανά κράτηση (D9). `route.ts`: `{ kind: 'manage' }` για `/m/<token 22 χαρακτήρων>` (το `m` είναι ήδη δεσμευμένο).
- Chunks: `ServiceStep`, `StaffStep`, `SlotStep` (λωρίδα ημερομηνιών, χωρίς picker) στο αρχικό· ένα lazy chunk με prefetch στο πάτημα slot για `DetailsStep`, `OtpStep` (`autocomplete="one-time-code"`, `inputmode="numeric"`, 16px), `ClientChoiceStep`, `ConfirmStep`· το `ManagePage` σε δικό του lazy chunk.
- **i18n ανά namespace** `common`, `booking`, `pro` (el/en): η είσοδος κράτησης εισάγει στατικά μόνο `common` + `booking`, η PWA όλα, ώστε τα κείμενα των 1.4–1.8 να μη μπαίνουν στη σελίδα κράτησης.
- Προϋπολογισμός, με αυτή τη σειρά: (1) μέρος του `dates.ts` μόνο με `Intl`, χωρίς locales του date-fns στο αρχικό chunk· (2) αρχικός κατάλογος από τον Worker, χωρίς πρώτο fetch (fetch μόνο ως εφεδρεία)· (3) χωρίς TanStack Query στην είσοδο κράτησης· (4) Preact/compat ως τελευταία λύση, με απόφαση τη 2η μέρα του βήματος αν η σελίδα ξεπερνά τα 115 KB.
- Worker `/<slug>`: το `injectBookingShell` βάζει τίτλο, Open Graph (από το `booking`), μεταβλητές θέματος (`src/shared/lib/theme.ts`) και το JSON του `public_booking_catalogue` με escape κατά `</script>`· άγνωστο ή κλειστό slug → κέλυφος SPA με 404· `/r/<code>` → 302 στο `/<slug>`.
- `src/features/booking/calendar.ts`: URL Google Calendar και .ics (UTC, escape, CRLF), με κείμενα από το `booking`. Ώρα που μόλις κλείστηκε → κοντινές εναλλακτικές από το `available_slots`· αποτυχία OTP → το τηλέφωνο της επιχείρησης ως link κλήσης.
- Η μετακίνηση από το link διαχείρισης (`manage_reschedule`, UI, πρότυπο `rescheduled_by_client`) γίνεται **τελευταία** μέσα στο 1.3, ώστε να κοπεί (C1 #2) χωρίς να αγγίξει την ακύρωση και το link νέας κράτησης.

**Tests**

- pgTAP `10_public_booking`, κωδικοί και όρια:
  - κανένα δικαίωμα των ρόλων του API στους νέους πίνακες· κωδικός ως HMAC· 6η προσπάθεια απορρίπτεται· λήξη στα 5′· νέα αποστολή πριν τα 60″ απορρίπτεται
  - όρια ανά αριθμό, IP, επιχείρηση και ημέρα· πλατφορμικό όριο και διακόπτης στο `otp_start`· αριθμός εκτός +3069 → απόρριψη· ώρα που δεν είναι πια ελεύθερη → κανένα SMS
  - challenge της Α που επαληθεύεται στη Β → απόρριψη· grant εφάπαξ στο `book_appointment`, λήγει, άκυρο σε άλλη επιχείρηση ή τηλέφωνο, και το `clients_for_phone` δεν το καταναλώνει· επανάληψη μετά την κατανάλωση του grant, με ίδιο κλειδί και payload → ίδιο ραντεβού, κανένα δεύτερο· άλλο payload με το ίδιο grant → απόρριψη· token έμπιστης συσκευής δεμένο σε επιχείρηση και τηλέφωνο, ανακλήσιμο
- pgTAP `10_public_booking`, πελάτες και link διαχείρισης:
  - `clients_for_phone` μόνο μετά από επαλήθευση· ποτέ συγχώνευση με τηλέφωνο· `phone_verified_at`: το OTP τον γράφει, η έμπιστη συσκευή όχι, αλλαγή τηλεφώνου από το προσωπικό τον μηδενίζει· `soft_opt_in` μόνο από `booking_form` με το κουτί ορατό
  - πολλά tokens ζωντανά μαζί· η ακύρωση τα ανακαλεί όλα· κανένα link ή token σε καθαρό κείμενο σε καμία στήλη
  - `manage_view` δεν αλλάζει τίποτα· ακύρωση μέσα στο παράθυρο απορρίπτεται, **εκτός** αν η κράτηση έγινε μέσα στο παράθυρο ή πριν από < 60′· η μετακίνηση κρατά το id και γράφει `rescheduled` με actor `client`
  - planner v1: μία επιβεβαίωση ανά online κράτηση, τίποτα από inserts του seed· το `next_visit_hint` περνά από την προεπιλογή του κλάδου στον διάμεσο στα 50 διαστήματα
- Vitest: reducer· Google Calendar και .ics· schemas· ίδια απάντηση για γνωστό και άγνωστο αριθμό· ο φρουρός των δοκιμαστικών αριθμών απορρίπτει prod· escape του ονόματος και του `</script>` στο `injectBookingShell`· **replay** του `book` → ίδιο ραντεβού και link που δουλεύει· κάθε πρότυπο SMS με τα μακρύτερα links (`dev.anaklo.gr/m/<22>`, `dev.anaklo.gr/r/<code>`) σε 1 SMS· κατάλογοι el = en **ανά namespace** και όριο μεγέθους του `booking`· `packages/verticals` = `private.vertical_defaults`.
- Playwright (κινητό, Chromium + WebKit): νέα συσκευή (OTP → κράτηση → επιβεβαίωση, με δοκιμαστικό αριθμό)· έμπιστη συσκευή χωρίς OTP (Chromium και WebKit· στο iPhone και με το χέρι)· **cookies απενεργοποιημένα**, η ροή ολοκληρώνεται με το grant· κοινό κινητό με μικρά ονόματα· ώρα κλεισμένη → εναλλακτικές· αποτυχία OTP → τηλέφωνο επιχείρησης· ακύρωση από το link ελευθερώνει την ώρα· μετακίνηση από το link.

**Κριτήρια εξόδου**

- `npm run size` ≤ 120 KB gzip, σε κάθε PR.
- Πραγματικές κρατήσεις στο `dev.anaklo.gr` από Instagram και Facebook in-app σε iOS και Android, με δεύτερη κράτηση χωρίς OTP στην ίδια συσκευή.
- Το `otp_sent / online κρατήσεις` βγαίνει με ένα query στο `messages_log`.

## 1.4 PWA επαγγελματία

- **Στόχος:** Στην εγκατεστημένη εφαρμογή ο κουρέας βλέπει «Σήμερα» και ημερολόγιο ημέρας με στήλη ανά επαγγελματία (των συναδέλφων ως «κατειλημμένο»), καταχωρεί τηλεφωνικό ραντεβού σε < 10″ και walk-in χωρίς τηλέφωνο, μετακινεί από λίστα ελεύθερων ωρών, σημειώνει no-show ή ακυρώνει. Τα περασμένα ραντεβού ολοκληρώνονται αυτόματα.
- **Μέρες:** 3,5
- **Εξαρτάται από:** 1.1 (σύνδεση), 1.2, 1.3 (0005: `messages_log`, planner).
- **Χωρίς Realtime (C2):** το ημερολόγιο κάνει refetch όταν η εφαρμογή ξαναπάρει focus και **κάθε 60″** όσο φαίνεται μια μέρα, μαζί με το push (1.5a). Τα query keys είναι ανά επιχείρηση, μέρα και επαγγελματία, ώστε το Realtime της Φάσης 3 να μπει με ένα hook, χωρίς refactor.

**Βάση: `0006_day_ops.sql`**

- `busy_calendar(p_business_id, p_local_date)`: τα ραντεβού των συναδέλφων ως μπλοκ, χωρίς πελάτη και τιμή (τα δικά του το staff, και όλα ο owner, τα διαβάζει απευθείας με RLS). `today_summary(p_business_id)`: επόμενα, κενά, προς σημείωση, αναμενόμενα έσοδα, που γίνονται `NULL` για staff **μέσα στο `_impl`**.
- Staff μόνο στα δικά του, owner/manager σε όλα: `set_appointment_status` (confirm, no-show, complete, διορθώσεις μέσα στο παράθυρο)· `cancel_appointment(p_business_id, …, reason code, p_notify)`· `staff_move_appointment` πάνω στο `move_core`, με idempotency key ανά προσπάθεια, τα flags του D8 και `p_notify` (SMS `rescheduled_by_business`). Και τα τρία καλούν τον planner· τα μηνύματα της επιχείρησης προγραμματίζονται από το 1.5a.
- `search_clients(p_business_id, query)`: `normalize_greek` + greeklish στο query, trigram στο `search_text`, τελευταία ψηφία τηλεφώνου, χωρίς συγχωνευμένους και ανωνυμοποιημένους, έως 20. Το χρησιμοποιούν το γρήγορο ραντεβού και η καρτέλα (1.8).
- `private.job_runs`, `private.record_job_run()` και `private.auto_complete_impl(p_now)`: δηλώνει `system` μέσα του, σέβεται το `auto_complete_after_min`, δεν αγγίζει ακυρωμένα· pg_cron ανά 10′, με job_run. `01_security`, `gen:types`.

**Edge Functions:** καμία.

**Frontend**

- «Σήμερα»: επόμενα ραντεβού, κενά, αναμενόμενα έσοδα μόνο για owner (με κουμπί ενέργειας), κάρτα «προς σημείωση». `DayView`: CSS grid, ώρα → pixel από το `dates.ts` (χωρίς βιβλιοθήκη ημερολογίου), chips επαγγελματιών, 1–2 στήλες στο κινητό.
- `AppointmentSheet`: confirm, no-show, ακύρωση με κωδικό λόγου, μετακίνηση, με επιλογή «ενημέρωση με SMS» στις δύο τελευταίες. `MoveFlow` και `QuickAddSheet` μοιράζονται ένα `SlotPicker` από το `staff_available_slots`.
- `QuickAddSheet`: αναζήτηση ή νέος πελάτης inline (ένα round trip), μετά υπηρεσία, επαγγελματίας, ώρα. `WalkInButton`: ραντεβού τώρα, για τον επαγγελματία που πατήθηκε.
- Καμία «επιτυχία» πριν απαντήσει ο server. Χωρίς σύνδεση ή σε timeout: «Δεν αποθηκεύτηκε — χωρίς σύνδεση», με retry και το **ίδιο** idempotency key.
- React Hook Form + `@hookform/resolvers` μόνο στην PWA (ADR-0001)· αν το `zodResolver` δεν δουλεύει με `zod/mini`, μικρός τοπικός resolver.

**Tests**

- pgTAP `11_day_ops`: `busy_calendar` χωρίς στήλες πελάτη ή τιμής· `today_summary_impl` ως staff → έσοδα `NULL`· το staff δεν μετακινεί ούτε ακυρώνει ραντεβού συναδέλφου, ο owner ναι· οι μετακινήσεις γράφουν `rescheduled`/`reassigned`, και σε κλεισμένη ώρα αποτυγχάνουν· auto-complete με την καθυστέρηση, χωρίς ακυρωμένα, με job_run, και μετά το staff διορθώνει μέσα στο παράθυρο (με reset του actor)· αναζήτηση ΓΙΩΡΓΟΣ, Γιώργος, giorgos, Giorgos και 4 τελευταίων ψηφίων, χωρίς συγχωνευμένους ή ανωνυμοποιημένους.
- `test:race`: μετακίνηση και κράτηση στην ίδια ώρα ταυτόχρονα → πετυχαίνει ακριβώς μία.
- Vitest: `dayLayout` σε μέρες 23 και 25 ωρών· διάταξη επικαλύψεων· schema γρήγορου ραντεβού.
- Playwright: τηλεφωνικό ραντεβού σε < 10″· walk-in χωρίς τηλέφωνο· μετακίνηση σε ελεύθερη ώρα· no-show.

**Κριτήρια εξόδου**

- Η ροή 3 του SPEC §5 δουλεύει σε πραγματικό iPhone, στην εγκατεστημένη εφαρμογή.
- Ένα δεύτερο κινητό βλέπει την αλλαγή το πολύ σε 60″ ή στο επόμενο focus. Τα job_runs του auto-complete φαίνονται στο dev.

## 1.5 Ειδοποιήσεις

- **Στόχος:** Η ροή 1 του SPEC §5 τρέχει πραγματικά: η επιβεβαίωση φτάνει ως 1 SMS GSM-7 σε Cosmote, Vodafone και Nova· η υπενθύμιση ακολουθεί τους κανόνες 24ω/26ω και τις ώρες ησυχίας· ακυρώσεις και αλλαγές, από τον πελάτη ή την επιχείρηση, στέλνουν SMS· ο επαγγελματίας παίρνει push για κάθε online κράτηση, ακύρωση ή αλλαγή.
- **Μέρες:** 3,5 (≈ 2 το 1.5a, ≈ 1,5 το 1.5b, από τις οποίες ~0,5 για το `sms-probe`, που γίνεται τις μέρες ~7–12).
- **Εξαρτάται από:** 1.5a: 1.3, 1.4, ADR-0010 (1.1). 1.5b: 1.5a και υπογεγραμμένος πάροχος. Το 1.5b δεν έχει migration, άρα μπορεί να πάει μετά τα 1.6–1.8 χωρίς πρόβλημα σειράς.

### 1.5a Planner, dispatcher, push (ψεύτικος adapter SMS)

**Βάση: `0007_messaging.sql`**

- `businesses`: `quiet_start`, `quiet_end` (προεπιλογή 22:00–09:00) και `reminder_mode` (`24h`, `evening_before`) με `grant update` στο `authenticated`· `sms_sender_id` (≤ 11 λατινικοί), `sms_daily_cap`, `sms_monthly_budget_cents` και `import_reminders` (το Anaklo είναι ο ορισμένος αποστολέας, SPEC §15) **χωρίς** GRANT (provisioning ή service). Η λίστα στηλών του `01_security` ενημερώνεται.
- `plan_messages_impl`, σώμα v2, με όλους τους κανόνες του SPEC §12 σε ένα σημείο:
  - επιβεβαίωση: πάντα σε online· σε τηλεφωνικό του προσωπικού μόνο αν ξεκινά σε ≥ 2ω· ποτέ σε walk-in ή εισαγωγή
  - υπενθύμιση: 24ω πριν (σε `evening_before`: 18:00 τοπική την προηγούμενη μέρα), μόνο αν η κράτηση έγινε ≥ 26ω νωρίτερα· αν πέφτει σε ώρες ησυχίας, πάει **νωρίτερα**, στο `quiet_start` − 1ω (21:00 με την προεπιλογή) πριν από τη νύχτα στην οποία πέφτει
  - `source = import`: υπενθύμιση μόνο για μελλοντικά ραντεβού και μόνο με `import_reminders`· ποτέ για παλιά
  - μετακίνηση: ξαναπρογραμματίζει τα εκκρεμή· ακύρωση: τα ακυρώνει· notify της επιχείρησης → `cancelled_by_business` με `/r/<code>` ή `rescheduled_by_business` με link διαχείρισης
  - push στον επαγγελματία (και στους owners, κατά τα `member_notification_prefs`) για νέα online κράτηση, ακύρωση ή αλλαγή
- `member_notification_prefs`: μόνο προεπιλογές (ο επαγγελματίας του ραντεβού και οι owners), με RLS, χωρίς UI.
- `private.claim_due_messages_impl`: `FOR UPDATE SKIP LOCKED` με lease· πλατφορμικός διακόπτης, `messaging_enabled` (μόνο υπενθυμίσεις και μάρκετινγκ), ημερήσια και μηνιαία όρια επιχείρησης και πλατφόρμας· νέο token για κάθε μήνυμα με link διαχείρισης. Το `suppression_list` κόβει μάρκετινγκ και μηνύματα ραντεβού από εισαγωγή· ένας πελάτης που ξανακλείνει μόνος του παίρνει κανονικά OTP και τα μηνύματα της κράτησής του.
- `record_delivery_report`: segments και κόστος όπως τα αναφέρει ο πάροχος. Μήνυμα με άγνωστη έκβαση δεν ξαναστέλνεται ποτέ αυτόματα.
- pg_net + pg_cron, με URLs και μυστικό του dispatch από Vault, και job_run σε κάθε job: «σπρώξιμο» του dispatch μετά το commit για γραμμές από RPCs της PWA· sweep κάθε 5′· νυχτερινό purge (OTP και tokens 30 μέρες μετά τη λήξη, `rate_limits`, `messages_log` παλαιότερα από 12 μήνες). Τα jobs με `cron.schedule('<όνομα>', …)`, ώστε να ξαναφτιάχνονται σε κάθε reset.
- Τοπικά και στο CI το `seed.sql` γράφει στο Vault (με upsert) URL του dispatch που φτάνει από το container της βάσης (όχι `127.0.0.1:54321`) και το μυστικό του. Στο remote το αντικαθιστά το `secrets:dev`.
- `push_subscriptions`, **και για τους δύο παρόχους** (ADR-0010 §2): ανά χρήστη, όχι ανά επιχείρηση (`user_id`, `provider` `onesignal`|`vapid` με `CHECK` και λίστα στο `_shared/domain.ts`, `subscription_id` του OneSignal ή `endpoint` και κλειδιά σε VAPID, `created_at`)· **`UNIQUE` στο `subscription_id`** (σε VAPID στο `endpoint`), ώστε ένα κοινό κινητό να ανήκει σε έναν χρήστη τη φορά· RLS `user_id = auth.uid()` και ρητά GRANT μόνο όσα χρειάζονται (ο χρήστης διαβάζει τις δικές του γραμμές). RPCs `register_push_subscription` (upsert: η συσκευή μετακινείται στον καλούντα· το `user_id` από το `auth.uid()`, ποτέ από τον browser) και `unregister_push_subscription`, με `_impl` + wrapper. Οι γραμμές σβήνονται στην αποσύνδεση, στην αφαίρεση από την τελευταία επιχείρηση και στην αλλαγή ρόλου που ανακαλεί τις συνεδρίες (`remove_member`/`set_member_role`, στην ίδια συναλλαγή). Αν το ADR-0010 κατέληξε σε VAPID, η επιπλέον δουλειά (κρυπτογράφηση RFC 8291, καθαρισμός στα 404/410) εκτιμάται στο τέλος του 1.1 και χρεώνεται στο buffer.
- `01_security`, `gen:types`.

**Edge Functions**

- `dispatch` (`verify_jwt = false`, όχι μέσω `/api`): εξουσιοδότηση με μυστικό header (από Vault)· claim → render στη γλώσσα του πελάτη → αποστολή → καταγραφή. SMS μέσω του ψεύτικου adapter, push μέσω OneSignal (ή VAPID, κατά το ADR-0010).
- `public-booking` και `manage` στέλνουν τα άμεσα (OTP, επιβεβαίωση, ακύρωση, αλλαγή, push) αμέσως μετά το commit, με το ίδιο `_shared/send.ts`· το sweep πιάνει ό,τι έμεινε.
- Push: μόνο με `include_subscription_ids`, από τις γραμμές του `push_subscriptions` των παραληπτών που βγάζει ο server από το `business_members`· ποτέ `external_id` ή aliases· payload από το `buildPushPayload` του `_shared/onesignal.ts` (από το 1.1)· κείμενα από το `_shared/push-templates.ts` (el/en, εξαίρεση του κανόνα 8 στο ADR-0010 και στο CLAUDE.md)· χωρίς τηλέφωνο ή επώνυμο στο payload.
- Dev: έως 30 SMS/ημέρα και `SMS_ALLOWED_RECIPIENTS`. Νέο πρότυπο SMS `rescheduled_by_business`, με test 1 SMS.

**Frontend**

- Ρυθμίσεις → «Ειδοποιήσεις»: το κουμπί του 1.1 μεταφέρεται εδώ, με δοκιμαστικό push μέσω `dispatch`· στο iOS μόνο μέσα στην εγκατεστημένη εφαρμογή, αλλιώς οδηγία εγκατάστασης. Με την ενεργοποίηση: άδεια· αν η συσκευή έχει ήδη `PushSubscription.id`, πρώτα `register_push_subscription` (η γραμμή μετακινείται στον καλούντα) και `optIn()` μόνο αν πέτυχε· αν δεν έχει id (νέα συνδρομή, άρα καμία γραμμή), `optIn()`, ανάγνωση του id (από το 1.1) και `register_push_subscription`, και αν αυτό αποτύχει `optOut()` και μήνυμα αποτυχίας. Μια συσκευή δεν γίνεται ποτέ ενεργή όσο η γραμμή της ανήκει σε άλλον χρήστη (ADR-0010 §7). Στην αποσύνδεση: `optOut()` (από το 1.1) και `unregister_push_subscription`, πριν από το `signOut`, όσο υπάρχει ακόμη session, με τις ίδιες εγγυήσεις σειράς και χρόνου.
- Οι επιλογές «ενημέρωση με SMS» του 1.4 πλέον στέλνουν.

**Tests**

- pgTAP `12_messaging`, προγραμματισμός: υπενθύμιση μόνο αν η κράτηση έγινε ≥ 26ω νωρίτερα· `evening_before`· ώρες ησυχίας σωστές γύρω από την 2026-10-25· η μετακίνηση ξαναπρογραμματίζει, η ακύρωση ακυρώνει· notify → ακριβώς ένα `rescheduled_by_business` ή `cancelled_by_business`· walk-in τίποτα· τηλεφωνικό σε < 2ω χωρίς επιβεβαίωση· εισαγωγή: υπενθύμιση μόνο για μελλοντικά και μόνο με `import_reminders`· `messaging_enabled = false`: καμία υπενθύμιση, αλλά OTP, επιβεβαιώσεις και ακυρώσεις φεύγουν.
- pgTAP `12_messaging`, αποστολή: μία γραμμή ανά ραντεβού/πρότυπο/ώρα· το claim προσπερνά όσα έχουν lease και ξαναπαίρνει τα ληγμένα· όρια και διακόπτης σταματούν το claim· αριθμός του suppression δεν παίρνει υπενθύμιση από εισαγωγή, αλλά παίρνει την επιβεβαίωση νέας online κράτησης· νέο token ανά μήνυμα· οι ρόλοι του API χωρίς πρόσβαση.
- pgTAP `push_subscriptions`: μια γραμμή γράφεται μόνο για το `auth.uid()`· νέα καταχώριση της ίδιας συνδρομής μετακινεί τη γραμμή στον καλούντα· ο χρήστης δεν βλέπει και δεν σβήνει γραμμές άλλου· το `unregister_push_subscription` σβήνει μόνο τη δική του· `remove_member` (τελευταία επιχείρηση) και `set_member_role` σβήνουν τις γραμμές του· `anon` χωρίς πρόσβαση· allow-lists του `01_security`.
- `test:race`: δύο dispatchers ταυτόχρονα → κάθε μήνυμα στέλνεται το πολύ μία φορά.
- Vitest: payload push χωρίς προσωπικά δεδομένα και μόνο με `include_subscription_ids` από το `push_subscriptions`· τα νέα πρότυπα push στο `push-templates` (el = en, από το 1.1)· `enablePush` με υπάρχον `PushSubscription.id`: πρώτα `register_push_subscription`, και αν αποτύχει κανένα `optIn()`· με νέα συνδρομή: αν αποτύχει το `register_push_subscription` μετά το `optIn()`, ακολουθεί `optOut()` (η συσκευή δεν μένει ενεργή με γραμμή άλλου χρήστη)· `rescheduled_by_business` σε 1 SMS. Playwright: ο πελάτης ακυρώνει με το link → γραμμή στο `messages_log` και καταγεγραμμένο (ψεύτικο) push.

**Κριτήρια εξόδου 1.5a**

- Αν σκοτωθεί το dispatch στη μέση μιας παρτίδας, κάθε μήνυμα στέλνεται το πολύ μία φορά.
- Push φτάνει σε εγκατεστημένο iPhone με την εφαρμογή κλειστή, από πραγματική online κράτηση στο dev.
- Οι υπενθυμίσεις γύρω από την αλλαγή ώρας της 2026-10-25 ελέγχονται ζωντανά στο dev.

### 1.5b Πάροχος SMS

**Βάση:** κανένα migration. **Frontend:** καμία αλλαγή.

**Πίνακας επιλογής (C4, pass/fail).** Πάροχος που αποτυγχάνει σε ένα από τα τέσσερα απορρίπτεται:

| #   | Κριτήριο                                | Περνά όταν                                                                                                                                                                                                                  |
| --- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | GSM-7 χωρίς αυτόματη μετατροπή σε UCS-2 | ρητό `data_coding=0` ή αντίστοιχη ρύθμιση. Αν δεν γίνεται, ο πάροχος **απορρίπτει** το μήνυμα αντί να το στείλει σιωπηλά ως UCS-2. Κάθε πρότυπο με όλα τα Γ Δ Θ Λ Ξ Π Σ Φ Ψ Ω φτάνει ως 1 SMS σε Cosmote, Vodafone και Nova |
| 2   | Delivery webhooks                       | κατάσταση **και** αριθμός SMS για κάθε μήνυμα                                                                                                                                                                               |
| 3   | Sender ID                               | αλφαριθμητικό, ≤ 11 χαρακτήρες, με καταχώριση, και εμφανίζεται σωστά                                                                                                                                                        |
| 4   | Όριο δαπάνης                            | προπληρωμένος λογαριασμός ή σκληρό όριο δαπάνης στον πάροχο, επιπλέον των δικών μας ορίων                                                                                                                                   |

Βαθμολογούνται επίσης, χωρίς αποκλεισμό: τιμή ανά SMS, allow-list χωρών, link που πατιέται χωρίς `https://`, αυτόματη συμπλήρωση κωδικού στο iOS, DPA και επεξεργασία στην ΕΕ, Viber αργότερα. Αποτελέσματα και επιλογή στο ADR-0011.

**Script `scripts/sms-probe.ts`** (Deno): γράφεται τις μέρες ~7–8, παράλληλα με το 1.2, και τρέχει μέχρι τη μέρα ~12. Καλεί απευθείας το HTTP API κάθε δοκιμαστικού παρόχου, όχι μέσω του `_shared/sms-provider.ts` που έρχεται στο 1.3. Στέλνει κάθε πρότυπο στα όριά του, με όλα τα Γ Δ Θ Λ Ξ Π Σ Φ Ψ Ω, μέσω κάθε δοκιμαστικού λογαριασμού μόλις ανοίξει. Τα delivery reports τα διαβάζει από το API ή το dashboard του παρόχου (το `sms-dlr` έρχεται στο 1.5b). Οι ~0,5 μέρες του χρεώνονται στο 1.5b.

**Edge Functions**

- Adapter του παρόχου στο `_shared/sms-provider.ts`: ρητό GSM-7, sender ID, callback URL για delivery reports. Ο ψεύτικος adapter μένει για τοπικά και CI.
- `sms-dlr` (webhook, `verify_jwt = false`, καλείται απευθείας από τον πάροχο, όχι μέσω `/api`): έλεγχος υπογραφής ή μυστικού· `record_delivery_report`· segments > 1 → σφάλμα στο log (ειδοποίηση Sentry από το 1.9).

**Tests:** Vitest για την αντιστοίχιση αιτήματος (σημαία GSM-7, sender, callback), το parsing του delivery report και την απόρριψη χωρίς σωστή υπογραφή.

**Κριτήρια εξόδου 1.5b**

- Πραγματικά SMS επιβεβαίωσης και υπενθύμισης σε Cosmote, Vodafone και Nova, **1 SMS** το καθένα κατά το delivery report. Στο ADR-0011 καταγράφεται αν το link (χωρίς `https://`) πατιέται και αν το iOS προτείνει τον κωδικό OTP· βαθμολογούνται, δεν μπλοκάρουν (C4).
- Προπληρωμή ή σκληρό όριο ρυθμισμένο στον πάροχο. ADR-0011 γραμμένο.

## 1.6 Οθόνες ρυθμίσεων και έκτακτη απουσία

- **Στόχος:** Ο owner ρυθμίζει το μαγαζί από το `/app/settings`: υπηρεσίες (με διάρκεια και τιμή ανά επαγγελματία), προσωπικό (και χωρίς login), εβδομαδιαία ωράρια με σπαστά, **κλεισίματα** (μαγαζιού ή επαγγελματία, κλειστό ή έξτρα ώρες), άδειες και πολιτική κρατήσεων. Όταν ένας επαγγελματίας λείπει έκτακτα σήμερα (`time_off` με `leave`, χωρίς αιτία· GDPR άρ. 9), εμφανίζονται τα ραντεβού της ημέρας του, και καθένα ανατίθεται σε ελεύθερο συνάδελφο ή ακυρώνεται με SMS.
- **Μέρες:** 4
- **Εξαρτάται από:** 1.4 (μετακίνηση, ακύρωση), 1.5a (SMS της επιχείρησης).

**Βάση: `0008_schedule_ops.sql`**

- Exclusion `time_off_no_overlap` ανά επαγγελματία: το μόνο που λείπει, αφού ωράρια και εξαιρέσεις το έχουν ήδη (0001).
- `replace_week_hours(p_business_id, p_staff_id, rows)`, μόνο owner/manager: delete-then-insert σε μία κλήση (το exclusion δεν είναι deferrable και το PostgREST δεν τρέχει transaction πολλών εντολών). Γραμμές που επικαλύπτονται → `23P01`, και τίποτα δεν αλλάζει.
- `schedule_conflicts(p_business_id, staff ή null, from, to)`: ραντεβού `booked`/`confirmed` εκτός νέου ωραρίου, σε κλείσιμο ή σε άδεια, χωρίς ποτέ τον λόγο άδειας συναδέλφου.
- `mark_absence(p_business_id, p_staff_id, from, to)`: γράφει άδεια `leave`· αν υπάρχει ήδη άδεια που επικαλύπτεται, την κρατά ή την επεκτείνει αντί να γράψει δεύτερη· επιστρέφει τις συγκρούσεις.
- Οι υπόλοιπες εγγραφές (υπηρεσίες, προσωπικό, εξαιρέσεις, άδειες) με τα υπάρχοντα RLS και GRANT, από το `api.ts` κάθε feature. `01_security`, `gen:types`.

**Edge Functions:** καμία· η ακύρωση με SMS χρησιμοποιεί τις RPCs του 1.4 και την αποστολή του 1.5a.

**Frontend**

- `features/services`: `ServiceList`, `ServiceSheet` (διάρκεια, buffer, τιμή μέσω `money.ts`, `online_bookable`, επαγγελματίες με custom διάρκεια και τιμή)· κατηγορίες μόνο από το provisioning. `features/staff`: `StaffList`, `StaffSheet` (όνομα, χρώμα, active, σειρά), `WeekHoursEditor` (σπαστά, «αντιγραφή σε όλες τις μέρες»).
- `features/settings`: `ClosuresList` (μαγαζί ή επαγγελματίας, κλειστό ή έξτρα ώρες)· `TimeOffSheet` (λόγοι από το `TIME_OFF_REASONS`)· `BookingPolicyForm` (βήμα slots, ελάχιστη προειδοποίηση, μέγιστη απόσταση, προειδοποίηση ακύρωσης, αυτόματη ολοκλήρωση, παράθυρο διόρθωσης, `allow_any_staff`, `booking_enabled`, ώρες ησυχίας, τρόπος υπενθύμισης). Το θέμα αλλάζει μόνο από script.
- `AbsenceFlow` → `ConflictResolver`: για κάθε ραντεβού, ανάθεση (`staff_available_slots` των συναδέλφων και `staff_move_appointment` με notify) ή ακύρωση με SMS. Κανένα κείμενο ή κλειδί i18n δεν αναφέρει ασθένεια.
- Το `BookingPolicyForm` γίνεται **τελευταίο** μέσα στο 1.6 (C1 #3)· το `ClosuresList` δεν κόβεται ποτέ.

**Tests**

- pgTAP `07_schedules` (επέκταση): οι επικαλυπτόμενες άδειες απορρίπτονται.
- pgTAP `13_schedule_ops`: `replace_week_hours` ατομικό, και το staff δεν αλλάζει ωράρια· συγκρούσεις για άδεια και για μικρότερο ωράριο, χωρίς τα ακυρωμένα και χωρίς τον λόγο άδειας συναδέλφου· `mark_absence` πάνω σε υπάρχουσα άδεια ούτε αποτυγχάνει ούτε γράφει δεύτερη γραμμή· ακύρωση με notify → ακριβώς ένα SMS.
- Playwright: ο owner προσθέτει υπηρεσία, σπαστό ωράριο και κλείσιμο· επαγγελματίας απών σήμερα → ανάθεση ενός ραντεβού και ακύρωση ενός με SMS.

**Κριτήρια εξόδου**

- Το JSON του provisioning και οι οθόνες περιγράφουν το ίδιο μαγαζί. Η ροή 6 του SPEC §5 δουλεύει σε κινητό.

## 1.7 Ασφάλεια και μέλη

- **Στόχος:** Owner και manager έχουν δεύτερο βήμα σύνδεσης με εφαρμογή κωδικών (TOTP, C3), με δεύτερη συσκευή και διαδικασία ανάκτησης από τη Nous· το staff μένει μόνο με κωδικό email. Οι κρίσιμες ενέργειες ζητούν **φρέσκο κωδικό** (≤ 5′, C6), με έλεγχο στον server: πρόσκληση και διαχείριση μελών (και owner), αλλαγή ταυτότητας της επιχείρησης, αλλαγή ή αφαίρεση συσκευών κωδικών, ανωνυμοποίηση (1.8), και όταν έρθουν η εξαγωγή πελατολογίου και η απενεργοποίηση επιχείρησης (πίνακας παρακάτω). Οι καθημερινές ενέργειες θέλουν μόνο το session. Για τον manager το TOTP προστατεύει τον λογαριασμό (ποσά, πελάτες, ρυθμίσεις), τις δικές του συσκευές κωδικών και τις μελλοντικές εξαγωγές.
- **Μέρες:** 5
  - TOTP ~2,5 (οδηγός εγγραφής, δεύτερη συσκευή, οθόνη χαμένης συσκευής, step-up, reset της Nous, ανάκληση sessions, e2e), από τις οποίες ~0,5 ήταν ήδη στο πλάνο: **+2** (+1 η C3, +1 οι προσθήκες της 2026-09-27)
  - φρέσκος κωδικός ~1 (C6, **+1**): `require_fresh_totp` με τα δύο hints σε κάθε κρίσιμο `_impl`, `StepUpSheet` και για τα δύο, `business_members` μόνο μέσω RPC, `authorize_factor_change`, `manage-factors`, λίστα συσκευών στην «Ασφάλεια», οι έλεγχοι της μέρας 1
  - προσκλήσεις, RPC ταυτότητας και RPCs μελών ~1,5
- **Εξαρτάται από:** 1.1 (σύνδεση, πολιτική session)· το migration μπαίνει μετά το 0008.
- **Μέρα 1 του βήματος, πριν από τα υπόλοιπα:**
  1. Integration test: νέο verify ανανεώνει το timestamp του `totp` στο `amr` του JWT (βλ. Tests). Όλος ο C6 στηρίζεται σε αυτό· αν αποτύχει, σταματάμε και ρωτάμε.
  2. Στο `anaklo-dev`: δέχεται το hosted Supabase trigger στο `auth.mfa_factors` από migration; Δοκιμή μέσα σε συναλλαγή με rollback, με το `db:test:dev`, ώστε να μη μείνει τίποτα. Το αποτέλεσμα γράφεται στο ADR-0009 και αποφασίζει αν η ανίχνευση του 1.9 τρέχει αμέσως από trigger ή από job ανά 5′.
  3. Η ανάκληση sessions στο remote (`delete from auth.sessions`), με την εφεδρεία του ADR-0009 §19 αν δεν επιτρέπεται.

**Σχέδιο TOTP (C3 και προσθήκες της 2026-09-27)**

- Supabase MFA με παράγοντα TOTP. **Υποχρεωτική εγγραφή για owner και manager** στην πρώτη σύνδεση μετά το deploy, με οθόνη που μπλοκάρει.
- **Staff: μόνο κωδικός email, ποτέ TOTP.** Αν ο υψηλότερος ρόλος ενός owner ή manager πέσει σε staff ή σε κανέναν (υποβιβασμός ή αφαίρεση), οι παράγοντές του σβήνονται στον server (βλ. «Μέλη και ταυτότητα»).
- Owner/manager με επαληθευμένο παράγοντα δίνουν κωδικό από την εφαρμογή κωδικών μετά τον κωδικό email σε κάθε **νέα** σύνδεση ή συσκευή (εγκρίθηκε 2026-09-27). Το session κρατά `aal2` στα refresh, άρα μέσα στην εφαρμογή owner και manager είναι ήδη σε `aal2`: οι καθημερινές ενέργειες δεν ζητούν τίποτα άλλο, οι κρίσιμες ζητούν φρέσκο κωδικό (παρακάτω).
- Remote: TOTP ενεργό στο dashboard (λίστα του `SETUP.md`).

**Φρέσκος κωδικός για κρίσιμες ενέργειες (C6, εγκρίθηκε 2026-09-28)**

- **Κανόνας:** session `aal2` **και** μέθοδος `totp` στο claim `amr` του JWT με timestamp ≥ `now()` − παράθυρο. Παράθυρο 5′ (300 s) στο `private.platform_settings.fresh_totp_max_age_seconds`: προεπιλογή 300, `CHECK` από 0 έως 300, ώστε η ρύθμιση να κάνει τον κανόνα μόνο αυστηρότερο.
- **Μία υλοποίηση, σε SQL:** `private.has_fresh_totp()` (boolean) και `private.require_fresh_totp()`, που σηκώνει `42501` με hint:
  - `aal2_required`, όταν το session είναι `aal1`
  - `fresh_totp_required`, όταν είναι `aal2` αλλά το timestamp του `totp` είναι παλαιότερο από το παράθυρο ή λείπει (π.χ. `amr` μόνο με `otp`, δηλαδή κωδικό email)
- Καλείται **μέσα** σε κάθε `_impl` της λίστας, μετά τον έλεγχο συμμετοχής και ρόλου· ποτέ μόνο στο UI ή στο wrapper. Οι Edge Functions (`invite-member`, `manage-factors`) καλούν πρώτα RPC ως ο χρήστης (ίδιος έλεγχος SQL) και **μετά** φτιάχνουν client `service_role`.
- **Γιατί το timestamp είναι αξιόπιστο:** σε κάθε επιτυχημένο MFA verify το Supabase Auth κάνει upsert στο `mfa_amr_claims.updated_at = now()` του session (`models/amr.go`, `AddClaimToSession`, ελεγμένο στον κώδικα του `supabase/auth`)· αυτό γίνεται το timestamp του `totp` στο επόμενο access token. Το επιβεβαιώνει το integration test της μέρας 1 στο αποκωδικοποιημένο JWT.
- **Κρίσιμες ενέργειες** (ο ρόλος που χρειάζεται δεν αλλάζει):

| Ενέργεια                                             | Πού ελέγχεται                                                                                 | Ποιος                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------- |
| Ανωνυμοποίηση πελάτη                                 | `erase_client` (1.8)                                                                          | owner                              |
| Αλλαγές μελών και ρόλων                              | `can_manage_members` (ο έλεγχος του `invite-member`), `set_member_role`, `remove_member`      | owner                              |
| Προσθήκη ή αφαίρεση owner                            | τα ίδια RPCs μελών, με ρόλο owner                                                             | owner                              |
| Αλλαγή slug, ζώνης ώρας, νομίσματος                  | `change_business_identity`                                                                    | owner                              |
| Εξαγωγή πελατολογίου                                 | κάθε RPC ή Edge Function εξαγωγής, όταν έρθει (καμία στη Φάση 1)                              | owner, manager                     |
| Αλλαγή ή αφαίρεση συσκευών κωδικών (παράγοντες TOTP) | `authorize_factor_change`, `manage-factors`                                                   | ο ίδιος ο χρήστης (owner, manager) |
| Απενεργοποίηση επιχείρησης (τερματισμός λογαριασμού) | μελλοντικό `deactivate_business` (Φάση 5)· **όχι** το `booking_enabled`, καθημερινή ρύθμιση   | owner                              |

- **Όχι στις καθημερινές ενέργειες:** κρατήσεις, μετακινήσεις, ακυρώσεις, πελάτες, σημειώσεις, συναινέσεις, ωράρια, κλεισίματα, άδειες, πολιτική κρατήσεων, `booking_enabled`, ρυθμίσεις. Θέλουν μόνο το session· owner και manager είναι ήδη `aal2` από τη σύνδεση.
- **Καμία παράκαμψη από πίνακες:** στο 0009 το `business_members` χάνει `INSERT`/`UPDATE`/`DELETE` για τον `authenticated` (μένει μόνο `SELECT`)· κάθε αλλαγή μέλους περνά από τα RPCs. Οι restrictive πολιτικές `aal2` της Φάσης 0 μένουν ως δεύτερη γραμμή άμυνας.
- **Τοπικό seed και e2e:** παράθυρο **10″**. Όχι 0: με 0 δεν θα περνούσε ούτε η επανάληψη αμέσως μετά το φύλλο κωδικού (το timestamp του verify είναι πάντα λίγο πριν από το `now()` της επόμενης κλήσης), άρα καμία κρίσιμη ενέργεια δεν θα πετύχαινε στα e2e. Ο helper του Playwright περιμένει να παλιώσει ο κωδικός του session πέρα από τα 10″ πριν από κάθε κρίσιμη ενέργεια, ώστε το φύλλο να εμφανίζεται πάντα. Το pgTAP ορίζει ρητά το παράθυρο (βλ. Κανόνες)· στο remote ισχύει η προεπιλογή 300.

**Συσκευές κωδικών: προσθήκη και αφαίρεση (C6)**

- **Όριο του Supabase Pro**, γραμμένο ρητά στο ADR-0009: τους παράγοντες τους γράφουν και τους σβήνουν τα endpoints του ίδιου του GoTrue. Το GoTrue ζητά ήδη `aal2` για να προστεθεί παράγοντας όταν υπάρχει επαληθευμένος και για να σβηστεί επαληθευμένος, αλλά **δεν** ελέγχει φρεσκάδα· και το μόνο hook που θα μπορούσε να αρνηθεί (MFA Verification Attempt) υπάρχει μόνο σε Teams/Enterprise. Άρα η εφαρμογή περνά πάντα από τον δικό μας έλεγχο, και ό,τι γίνει απευθείας στο GoTrue (π.χ. με κλεμμένο session `aal2`) ανιχνεύεται στο 1.9: ο νέος ξένος παράγοντας σβήνεται, μια αφαίρεση δεν αναστρέφεται (μόνο ανάκληση sessions και ειδοποίηση).
- `authorize_factor_change(p_action, p_factor_id)` (`authenticated`· εξαίρεση του κανόνα `p_business_id`, γιατί αφορά μόνο τους παράγοντες του `auth.uid()`). Χρήστης που δεν είναι owner ή manager σε καμία επιχείρηση → `42501` χωρίς hint (το staff δεν γράφει ποτέ παράγοντα, ADR-0009 §18). Μετά `private.require_fresh_totp()` → γραμμή άδειας στο `private.factor_change_grants` (ισχύς 10′) και `audit_log` σε κάθε επιχείρηση όπου ο χρήστης είναι owner ή manager.
  - `remove`: ο παράγοντας πρέπει να είναι του χρήστη (αλλιώς `42501`)· **άρνηση** για τον τελευταίο επαληθευμένο παράγοντα owner/manager (πρώτα προσθέτεις άλλον).
  - `add`: με φρέσκο κωδικό όταν υπάρχει ήδη επαληθευμένος παράγοντας. Χωρίς κανέναν (πρώτη εγγραφή, ή μετά από reset της Nous) η άδεια δίνεται χωρίς φρεσκάδα, αφού δεν υπάρχει ακόμη κωδικός· η οθόνη «Πρόσθεσε δεύτερη συσκευή» έρχεται αμέσως μετά το πρώτο verify, άρα εκεί ο κωδικός συνήθως είναι ήδη φρέσκος.
- **Αφαίρεση μόνο μέσω της Edge Function `manage-factors`:** `authorize_factor_change('remove', factor_id)` ως ο χρήστης και, μόνο αν περάσει, client `service_role` και `auth.admin.mfa.deleteFactor`. Η εφαρμογή δεν καλεί ποτέ `mfa.unenroll` για επαληθευμένο παράγοντα (μόνο για τους μη επαληθευμένους, πριν από νέα εγγραφή).
- **Προσθήκη** (δεύτερη συσκευή ή αντικατάσταση): πρώτα `authorize_factor_change('add')`, μετά `mfa.enroll` + `challenge` + `verify` στο GoTrue. Αντικατάσταση = προσθήκη της νέας και μετά αφαίρεση της παλιάς.
- **Χωρίς φρεσκάδα, αλλά με άδεια:** το `mfa-reset.mjs` της Nous (ο χρήστης έχασε τη συσκευή· ταυτότητα ελεγμένη, `audit_log`) και η διαγραφή παραγόντων στον υποβιβασμό ή στην αφαίρεση μέλους (ενεργεί ο owner, με φρέσκο κωδικό). Γράφουν κι αυτά γραμμή στο `private.factor_change_grants`, ώστε ο ανιχνευτής του 1.9 να μην τα σημειώσει.

**Εγγραφή: οδηγός σε απλή γλώσσα**

- Το UI δεν γράφει ποτέ «TOTP», «MFA» ή «2FA». Λέει «εφαρμογή κωδικών», «κωδικός 6 ψηφίων», «δεύτερη συσκευή». Τρία βήματα:
  1. «Κατέβασε μια εφαρμογή κωδικών» (π.χ. Google Authenticator, Microsoft Authenticator· στο iPhone και οι ενσωματωμένοι «Κωδικοί»).
  2. «Σκάναρε τον κωδικό QR» με την εφαρμογή κωδικών από άλλη συσκευή· ή, στο ίδιο κινητό, κουμπί «Άνοιγμα στην εφαρμογή κωδικών» (`otpauth://`)· ή «Αντιγραφή κλειδιού».
  3. «Γράψε τον κωδικό 6 ψηφίων».
- Κάθε εγγραφή ξεκινά με `authorize_factor_change('add')` (η πρώτη χωρίς φρεσκάδα). Το `mfa.enroll` επιστρέφει QR σε SVG (χωρίς βιβλιοθήκη QR), το secret και URI `otpauth://`. Πεδίο με `autocomplete="one-time-code"`, `inputmode="numeric"`, 16px.
- Πριν από νέα εγγραφή σβήνονται οι **μη επαληθευμένοι** παράγοντες του χρήστη. Το `factorId` σε αναμονή μένει στο `sessionStorage`, γιατί η standalone PWA του iOS μπορεί να ξαναφορτώσει όταν ο χρήστης πάει στην εφαρμογή κωδικών.

**Δεύτερη συσκευή**

- Αμέσως μετά την επαλήθευση του πρώτου παράγοντα: **υποχρεωτική** οθόνη «Πρόσθεσε δεύτερη συσκευή», που εμφανίζεται πάντα, με δύο επιλογές:
  - «Προσθήκη τώρα»: εγγραφή δεύτερου παράγοντα TOTP σε άλλη συσκευή, με διαφορετικό φιλικό όνομα, με τα ίδια τρία βήματα. Η άδεια `add` συνήθως περνά χωρίς φύλλο, γιατί ο κωδικός μόλις δόθηκε· αν έχει περάσει το παράθυρο από το verify, ανοίγει το `StepUpSheet`.
  - «Αργότερα»: ενεργό μόνο αφού τσεκαριστεί η ρητή επιβεβαίωση «Καταλαβαίνω ότι αν χάσω αυτή τη συσκευή θα χρειαστώ τη Nous».
- Όσο υπάρχει ένας μόνο επαληθευμένος παράγοντας: banner προειδοποίησης στις Ρυθμίσεις → Ασφάλεια και υπενθύμιση (η ίδια οθόνη) μετά από κάθε νέα σύνδεση. Η απόφαση από καθαρή συνάρτηση `needsSecondDevice(verifiedFactorCount)`, πάνω στο `mfa.listFactors()`. Αργότερα, η προσθήκη από τις Ρυθμίσεις → Ασφάλεια θέλει φρέσκο κωδικό.

**Χαμένη συσκευή και reset από τη Nous**

- Οθόνη «Χάσατε τη συσκευή σας;», με link από την οθόνη του κωδικού: αν ο χρήστης πρόσθεσε δεύτερη συσκευή, δίνει τον κωδικό από εκεί· αλλιώς επικοινωνεί με τη Nous (στοιχεία επικοινωνίας από ρύθμιση της εφαρμογής, κείμενα από i18n). Εξηγεί ότι η Nous θα επαληθεύσει την ταυτότητά του και ότι η εφαρμογή **δεν** έχει άλλο τρόπο παράκαμψης.
- Διαδικασία της Nous στο runbook `docs/runbooks/mfa-reset.md`, με το `scripts/mfa-reset.mjs` (dev από προεπιλογή, `--prod` ρητά):
  1. Αίτημα μόνο από τον ίδιο τον χρήστη, από γνωστό κανάλι.
  2. Επαλήθευση ταυτότητας: κωδικός που στέλνει η Nous στο email του λογαριασμού **και** κλήση πίσω στο τηλέφωνο της επιχείρησης που υπάρχει ήδη (`businesses.phone_e164` ή ο αριθμός του provisioning), **ποτέ** σε αριθμό που δίνεται στο αίτημα. Για manager, και γραπτή επιβεβαίωση από τον owner. Αν δεν γίνεται τίποτα από αυτά: έλεγχος με βίντεο ή από κοντά.
  3. Το script σβήνει **όλους** τους παράγοντες του χρήστη (admin API `auth.admin.mfa.deleteFactor`· το id από το RPC `user_id_for_email`, μόνο `service_role`) και ανακαλεί όλα τα sessions του (RPC `revoke_user_sessions`, μόνο `service_role`). Πριν από τη διαγραφή, το `record_support_action` (βήμα 4) γράφει άδεια αφαίρεσης (πηγή `nous_support`) για κάθε παράγοντα, ώστε ο ανιχνευτής του 1.9 να μην τη σημειώσει. Χωρίς φρέσκο κωδικό: η συσκευή χάθηκε.
  4. Γραμμή στο `audit_log` για κάθε επιχείρηση όπου ο χρήστης είναι owner ή manager: `actor_type = nous_support`, λόγος και αριθμός ticket (υποχρεωτικά `--reason` και `--ticket`), μέσω του `record_support_action` (μόνο `service_role`).
  5. Email στον χρήστη, και στον owner όταν έγινε reset σε manager (πρότυπο el/en στο runbook).
  6. Στην επόμενη σύνδεση το `decideAuthRoute` δίνει `enroll`, και μετά ακολουθεί η οθόνη «Πρόσθεσε δεύτερη συσκευή».
- Ποτέ reset με αίτημα μόνο από email. Ποτέ ανάγνωση ή αντιγραφή των secrets TOTP.

**Πολιτική session (ADR-0009)**

- Από το 1.1: access token 1 ώρα, rotation των refresh tokens, 30 μέρες αδράνειας → πλήρης σύνδεση (έλεγχος της εφαρμογής· στο prod και «Inactivity timeout» = 720h), αποσύνδεση μόνο της συσκευής (`scope: 'local'`) μαζί με `OneSignal.User.PushSubscription.optOut()` (από το 1.5a και `unregister_push_subscription`). Κανένα απόλυτο όριο διάρκειας.
- Στο 1.7: «Αποσύνδεση από όλες τις συσκευές» (`signOut({ scope: 'global' })`) στις Ρυθμίσεις → Ασφάλεια, και ανάκληση όλων των sessions ενός χρήστη όταν αλλάζει ο ρόλος του ή αφαιρείται (βλ. «Μέλη και ταυτότητα»).
- Μετά από κάθε αποσύνδεση η επόμενη είσοδος είναι **νέα** σύνδεση: κωδικός email και, για owner/manager, κωδικός από την εφαρμογή κωδικών.

**Διαδρομή μετά τη σύνδεση**

- Καθαρή συνάρτηση `decideAuthRoute(role, aal, hasVerifiedFactor)` → `enroll`, `challenge` ή `ok`, στο `src/features/auth/mfa-route.ts`. Ρόλος = ο υψηλότερος στις συμμετοχές του χρήστη, διαβασμένος ζωντανά από το `business_members`, ποτέ από το JWT· η εφαρμογή την ξανατρέχει σε κάθε loader, σε κάθε άνοιγμα και επιστροφή της εφαρμογής (focus) και όταν ένα αίτημα απαντήσει `401` ή `42501` **χωρίς** hint `aal2_required` ή `fresh_totp_required` (με αυτά τα δύο ανοίγει το `StepUpSheet`· ADR-0009 §10). Πίνακας tests στο Vitest:

| Ρόλος         | aal         | Επαληθευμένος παράγοντας | Διαδρομή  |
| ------------- | ----------- | ------------------------ | --------- |
| staff         | οποιοδήποτε | οποιοδήποτε              | ok        |
| owner/manager | οποιοδήποτε | όχι                      | enroll    |
| owner/manager | aal1        | ναι                      | challenge |
| owner/manager | aal2        | ναι                      | ok        |

Ο πίνακας καλύπτει όλους τους συνδυασμούς, όπως στο ADR-0009 §10 (και `aal2` χωρίς επαληθευμένο παράγοντα, π.χ. αμέσως μετά το `mfa-reset.mjs`). Το Vitest ελέγχει καθέναν: owner, manager, staff × `aal1`, `aal2` × με ή χωρίς παράγοντα. Η οθόνη «Πρόσθεσε δεύτερη συσκευή» δεν είναι διαδρομή του πίνακα: την ανοίγουν η ροή εγγραφής και η ροή `challenge`, με το `needsSecondDevice`. Η φρεσκάδα του κωδικού δεν είναι διαδρομή: τη ζητά ο server ανά ενέργεια, και απαντά το `StepUpSheet`.

**Μέλη και ταυτότητα**

- `invite-member`:
  1. ελέγχει ότι ο καλών είναι owner της επιχείρησης **με φρέσκο κωδικό** (C6), με RPC που καλείται **ως ο ίδιος ο χρήστης** (`can_manage_members(p_business_id)`), **πριν** χρησιμοποιήσει `service_role`, που παρακάμπτει το RLS και τις πολιτικές `aal2`· αν το `can_manage_members` απαντήσει `42501` με hint `aal2_required` ή `fresh_totp_required`, η function επιστρέφει 403 με σώμα `{ code: '42501', hint }` (το ίδιο hint), ώστε η PWA να ανοίξει το `StepUpSheet` όπως στις RPCs (και να ξαναστείλει μία φορά)
  2. `auth.admin.createUser` με επιβεβαιωμένο email, χωρίς invite link (θα άνοιγε στο Safari). Σε `email_exists` ο υπάρχων χρήστης ξαναχρησιμοποιείται: το id βρίσκεται με το RPC `user_id_for_email(p_email)`, μόνο για `service_role` (definer πάνω στο `auth.users`· το ίδιο χρησιμοποιεί και το `mfa-reset.mjs`)
  3. γραμμή στο `business_members` (manager ή staff, προαιρετικά `staff_id`) και `audit_log`, μέσω RPC μόνο για `service_role`
  4. η εφαρμογή δείχνει κείμενο για κοινοποίηση: σύνδεση στο `/app` με το email του
- Αφαίρεση μέλους και αλλαγή ρόλου: RPCs `remove_member(p_business_id, p_user_id)` και `set_member_role(p_business_id, p_user_id, p_role)` του `authenticated`, **όχι** απευθείας με RLS (ένα DELETE ή UPDATE που δεν περνά restrictive πολιτική επηρεάζει 0 γραμμές χωρίς σφάλμα: ούτε step-up ούτε σωστό μήνυμα). Από το 0009 ο `authenticated` δεν έχει καν `INSERT`/`UPDATE`/`DELETE` στο `business_members`.
  - Owner με φρέσκο κωδικό: `private.require_fresh_totp()` μέσα στο `_impl` (`42501` με hint `aal2_required` ή `fresh_totp_required`), και γραμμή στο `audit_log`. Ποτέ αφαίρεση ή υποβιβασμός του τελευταίου owner. Προσθήκη ή αφαίρεση owner (προαγωγή σε owner, υποβιβασμός ή αφαίρεση owner) περνά από τα ίδια RPCs, άρα με τον ίδιο έλεγχο. Οι restrictive πολιτικές της Φάσης 0 μένουν ως δεύτερη γραμμή άμυνας.
  - Στην ίδια συναλλαγή το `_impl` ανακαλεί όλα τα sessions του χρήστη (`private.revoke_user_sessions_impl`: `delete from auth.sessions where user_id = …`, definer). Το pgTAP το αποδεικνύει και στο remote με `db:test:dev`· αν το remote δεν το επιτρέπει, εφεδρεία: Edge Function με το admin API, με τον μηχανισμό που γράφεται στο ADR-0009 §19 την 1η μέρα του 1.7. Το access token που έχει ήδη εκδοθεί ζει έως 1 ώρα, αλλά ο ρόλος διαβάζεται ζωντανά από το `business_members`, οπότε το RLS κόβει την πρόσβαση στο επόμενο αίτημα και το `decideAuthRoute` εφαρμόζει τον νέο ρόλο στην επόμενη επανεκτίμηση.
  - Προαγωγή σε owner ή manager → στην επόμενη σύνδεση το `decideAuthRoute` δίνει `enroll`. Υποβιβασμός σε staff ή αφαίρεση → το ίδιο `_impl` (`set_member_role` ή `remove_member`) σβήνει τους παράγοντες του χρήστη (`auth.mfa_factors`), αν ο χρήστης δεν μένει owner ή manager σε άλλη επιχείρηση, και γράφει άδεια αφαίρεσης (πηγή `demotion`) για καθέναν στο `private.factor_change_grants`· ίδιος έλεγχος στο remote και ίδια εφεδρεία.
- `change_business_identity(p_business_id, p_slug, p_timezone, p_currency)`, owner με φρέσκο κωδικό (`private.require_fresh_totp()` στο `_impl`), με `audit_log` (όχι `vertical`: γράφεται μόνο στη δημιουργία, D6): ζώνη ώρας ή νόμισμα **απορρίπτονται** όσο υπάρχουν μελλοντικά ραντεβού `booked`/`confirmed`· το παλιό slug μένει στο `business_slug_aliases` ως redirect, ώστε να δουλεύουν τα links που έχουν ήδη σταλεί ή δημοσιευτεί· κανένα slug ή alias δεν περνά σε άλλη επιχείρηση· έλεγχος δεσμευμένων.
- Worker και `public_booking_catalogue`: alias → 301 στο τρέχον slug. Τα `/m/` και `/r/` δεν εξαρτώνται από το slug. Από το 1.7 το provisioning αρνείται slug που υπάρχει ως alias, και κάθε αλλαγή του σε υπάρχουσα επιχείρηση γράφει `audit_log` μέσω του `record_support_action`, με υποχρεωτικά `--reason` και `--ticket` και στο `provision-business.mjs` (όπως στο `mfa-reset.mjs`).

**Βάση: `0009_members_identity.sql`**

- `business_slug_aliases` (RLS, SELECT για τα μέλη, καμία εγγραφή από το API).
- `private.platform_settings.fresh_totp_max_age_seconds` (`int not null default 300`, `CHECK` από 0 έως 300)· το `seed.sql` βάζει 10 (τοπικά και στα e2e).
- `private.has_fresh_totp()` και `private.require_fresh_totp()` (διαβάζουν `aal` και `amr` από το `auth.jwt()`)· χωρίς GRANT στους ρόλους του API, τις καλούν μόνο τα definer `_impl`.
- `business_members`: `revoke insert, update, delete` από τον `authenticated` (μένει μόνο `SELECT`)· οι restrictive πολιτικές `aal2` μένουν.
- `private.factor_change_grants` (RLS, κανένα GRANT): χρήστης, ενέργεια `add`/`remove`, `factor_id` (στην αφαίρεση), πηγή (`user`, `nous_support`, `demotion`, `system`), `created_at`, λήξη (10′), `matched_at` (το γράφει ο ανιχνευτής του 1.9). Τύποι ως `text` + `CHECK`.
- Για `authenticated`: `change_business_identity`, `can_manage_members`, `set_member_role`, `remove_member` (όλα με `private.require_fresh_totp()` στο `_impl`), `authorize_factor_change`.
- Μόνο για `service_role`: `record_support_action` (υποχρεωτικά λόγος και ticket· στο `mfa_reset` γράφει και τις άδειες αφαίρεσης), `user_id_for_email` (definer πάνω στο `auth.users`), `revoke_user_sessions`, προσθήκη μέλους. Το `private.revoke_user_sessions_impl` είναι κοινό για τα RPCs μελών, το `mfa-reset.mjs` και την αντίδραση του 1.9.
- `01_security` (allow-lists: `business_members` μόνο `SELECT` για τον `authenticated`, οι νέες functions, η λίστα `service_role`), `gen:types`.

**Edge Functions**

- `invite-member` (`verify_jwt = true`, και έλεγχος στον κώδικα όπως παραπάνω· δεν περνά από το `/api`, άρα χωρίς μυστικό proxy).
- `manage-factors` (`verify_jwt = true`, όχι μέσω `/api`): μόνο POST `{ action: 'remove', factor_id }`, με `zod/mini`.
  1. Client με το JWT του χρήστη → `authorize_factor_change('remove', factor_id)`. Σε `42501` με hint → 403 `{ code: '42501', hint }` (η PWA ανοίγει το `StepUpSheet` και ξαναστέλνει μία φορά)· σε άρνηση για τελευταίο παράγοντα ή ξένο παράγοντα → 403 χωρίς hint.
  2. **Μόνο μετά** client `service_role` και `auth.admin.mfa.deleteFactor`.
  - Η ροή σε καθαρή συνάρτηση με τους clients ως ορίσματα από το `index.ts` (όπως στο `invite-member`), ώστε το Vitest να αποδεικνύει ότι ο client `service_role` δεν φτιάχνεται πριν από την άδεια.

**Frontend**

- `src/features/auth/`: `MfaEnrollScreen` (μπλοκάρει· ο οδηγός των τριών βημάτων), `SecondDeviceScreen`, `MfaChallengeScreen` (με link «Χάσατε τη συσκευή σας;»), `LostDeviceScreen`, `StepUpSheet`, `step-up.ts`, `mfa-route.ts`.
- `StepUpSheet`: ανοίγει σε `42501` με hint `aal2_required` **ή** `fresh_totp_required` (και στο 403 των `invite-member`/`manage-factors` με το ίδιο σώμα). Απλό κείμενο, π.χ. «Για να συνεχίσεις, γράψε τον κωδικό 6 ψηφίων από την εφαρμογή κωδικών», ποτέ «TOTP», «MFA» ή «2FA»· με δύο συσκευές, επιλογή συσκευής όπως στο `MfaChallengeScreen`. `mfa.challenge` + `mfa.verify` → `refreshSession` → **μία** επανάληψη της κλήσης· δεύτερη αποτυχία → μήνυμα σφάλματος, καμία τρίτη κλήση. Η λογική στο `withStepUp(call)` (`step-up.ts`), κοινό για RPCs και Edge Functions.
- Κανένα προληπτικό άνοιγμα: το φύλλο ανοίγει μόνο όταν ο server απαντήσει με ένα από τα δύο hints, ώστε ο κανόνας φρεσκάδας να υπάρχει μόνο στην SQL (κανόνας 13 του CLAUDE.md). Κοστίζει μία επιπλέον κλήση στις σπάνιες κρίσιμες ενέργειες.
- Ρυθμίσεις:
  - «Ασφάλεια»: λίστα των επαληθευμένων συσκευών κωδικών (φιλικό όνομα, ημερομηνία προσθήκης, από το `mfa.listFactors()`)· «Προσθήκη συσκευής» (`authorize_factor_change('add')` → οδηγός εγγραφής)· «Αφαίρεση» ανά συσκευή μέσω του `manage-factors`, ανενεργή για την τελευταία, με εξήγηση «πρόσθεσε πρώτα άλλη συσκευή»· αντικατάσταση = προσθήκη και μετά αφαίρεση· banner όσο υπάρχει μία· «Αποσύνδεση από όλες τις συσκευές». Επιτυχία μόνο μετά την απάντηση του server.
  - «Μέλη»: λίστα, πρόσκληση, αφαίρεση, ρόλος, μέσω των RPCs και του `withStepUp`· επιτυχία μόνο μετά την απάντηση του server.
  - «Ταυτότητα»: slug, ζώνη ώρας, νόμισμα, με τις συνέπειες γραμμένες πριν την επιβεβαίωση, μέσω του `withStepUp`.
- Στοιχεία επικοινωνίας της Nous για τη `LostDeviceScreen` από το `src/shared/lib/env.ts` (νέες μεταβλητές στο `.env.example`)· τα κείμενα από i18n.
- Έγγραφα: ADR-0009 (δεύτερη συσκευή, reset της Nous, πολιτική session, φρέσκος κωδικός C6, όριο του Pro χωρίς hook άρνησης και υπολειπόμενος κίνδυνος, αποτελέσματα των ελέγχων της μέρας 1), ADR-0005, runbook `docs/runbooks/mfa-reset.md` (άδεια αφαίρεσης), SPEC §7 και §11, κανόνας φρέσκου κωδικού στο CLAUDE.md.

**Tests**

- pgTAP `14_members_identity`, φρέσκος κωδικός, για κάθε `_impl` της λίστας του 1.7 (`can_manage_members`, `set_member_role`, `remove_member`, `change_business_identity`, και `authorize_factor_change` για χρήστη με επαληθευμένο παράγοντα):
  - `aal1` → `42501` με hint `aal2_required`
  - `aal2` με `totp` πριν από 6′ → `fresh_totp_required`· `aal2` με `amr` μόνο `otp` → `fresh_totp_required`
  - `aal2` με `totp` πριν από 1′ → εντάξει· παράθυρο 0 → πάντα `fresh_totp_required`
  - το `CHECK` του `platform_settings` απορρίπτει τιμή > 300 (και < 0)
- pgTAP `14_members_identity`, ταυτότητα: `change_business_identity` απορρίπτει staff και manager (`42501`) και owner χωρίς φρέσκο κωδικό, δέχεται owner με φρέσκο κωδικό· ζώνη ώρας και νόμισμα απορρίπτονται με μελλοντικά ραντεβού και περνούν χωρίς· το παλιό slug γίνεται alias που το λύνει το `public_booking_catalogue`, και δεν περνά σε άλλη επιχείρηση.
- pgTAP `14_members_identity`, μέλη:
  - `can_manage_members`: staff, manager και owner άλλης επιχείρησης → `42501`· owner χωρίς φρέσκο κωδικό → `42501` με το αντίστοιχο hint· owner με φρέσκο κωδικό → true
  - `set_member_role` και `remove_member`: staff και manager → `42501`· owner χωρίς φρέσκο κωδικό → `42501` με hint· owner με φρέσκο κωδικό → η αλλαγή και μία γραμμή audit· ποτέ ο τελευταίος owner· προαγωγή σε owner και αφαίρεση owner με τον ίδιο έλεγχο
  - τα sessions του χρήστη σβήνονται (γραμμή στο `auth.sessions` πριν, καμία μετά), και με `db:test:dev` στο remote· υποβιβασμός σε staff σβήνει τους παράγοντες και γράφει άδεια αφαίρεσης για καθέναν, εκτός αν ο χρήστης μένει owner ή manager αλλού, και το ίδιο για `remove_member` (και όταν ο χρήστης δεν μένει μέλος πουθενά)
  - `record_support_action`, `user_id_for_email` και `revoke_user_sessions` μόνο για `service_role`· το `record_support_action` θέλει λόγο και ticket, γράφει `nous_support` και, στο `mfa_reset`, τις άδειες αφαίρεσης
- pgTAP `14_members_identity`, συσκευές κωδικών: `authorize_factor_change` αρνείται παλιό κωδικό· αρνείται την αφαίρεση του τελευταίου επαληθευμένου παράγοντα owner/manager και παράγοντα άλλου χρήστη· `add` χωρίς επαληθευμένο παράγοντα, σε `aal1` → άδεια· χρήστης μόνο staff → `42501` χωρίς hint· κάθε άδεια λήγει στα 10′ και γράφει `audit_log` σε κάθε επιχείρηση όπου ο χρήστης είναι owner ή manager.
- pgTAP `01_security`: `business_members` μόνο `SELECT` για τον `authenticated`, και απευθείας `INSERT`/`UPDATE`/`DELETE` ως `authenticated` (και σε `aal2` με φρέσκο κωδικό) → `42501`· κανένα GRANT στο `private.factor_change_grants`· οι νέες functions στις allow-lists.
- Integration (μέρα 1, `tests/db/` στο `test:race`, supabase-js στο τοπικό Supabase): enroll + verify → timestamp `totp` στο αποκωδικοποιημένο access token → αναμονή ≥ 2″ → νέο `challenge` + `verify` → `refreshSession` → νεότερο timestamp, κοντά στο τώρα. Μία φορά και με το χέρι στο `anaklo-dev`.
- Vitest:
  - `decideAuthRoute` σε όλους τους συνδυασμούς· `needsSecondDevice`· το «Αργότερα» μένει ανενεργό χωρίς την επιβεβαίωση
  - `withStepUp`: `aal2_required` και `fresh_totp_required` → `StepUpSheet` → μία επανάληψη της κλήσης· δεύτερη αποτυχία → σφάλμα, καμία τρίτη κλήση· `42501` χωρίς hint ή `401` → όχι φύλλο, νέο `decideAuthRoute`· καμία κλήση δεν ανοίγει το φύλλο χωρίς hint του server
  - κανένα value σε κανέναν κατάλογο i18n (el, en, όλα τα namespaces) δεν περιέχει «TOTP», «MFA» ή «2FA»
  - γεννήτρια TOTP του Playwright στο `e2e/lib/totp.ts` (`node:crypto`, RFC 6238, χωρίς εξάρτηση), με τα test vectors του RFC στο `e2e/lib/totp.test.ts`, που μπαίνει στο `include` του `vitest.config.ts`
  - το `invite-member` απορρίπτει `aal1` (403 με hint `aal2_required`), παλιό κωδικό (403 με hint `fresh_totp_required`) και μη owner (403 χωρίς hint) **πριν** φτιάξει client `service_role`
  - το `manage-factors` αρνείται χωρίς φρέσκο κωδικό (μέσω του `authorize_factor_change`) **πριν** φτιάξει client `service_role`· αρνείται τον τελευταίο παράγοντα· δέχεται μόνο `remove`
- Playwright:
  - Ξεχωριστοί χρήστες του seed (νέοι στο `seed.sql`, όπως στο 1.1) ανά σενάριο και ανά browser project: `owner-setup-chrome` και `owner-setup-webkit` (setup project ως `dependencies`, storageState ανά project, ώστε οι υπόλοιπες δοκιμές της PWA να ξεκινούν από session `aal2`), `owner-enroll`, `owner-devices`, `staff`. Πριν από κάθε εγγραφή το setup σβήνει τους παράγοντες του χρήστη με `auth.admin.mfa.deleteFactor`, αφού γράψει άδεια αφαίρεσης μέσω του `record_support_action` (όπως το `mfa-reset.mjs`, ώστε ο ανιχνευτής του 1.9 να μην το σημειώσει), γιατί το τρέξιμο επαναλαμβάνεται (τοπικά χωρίς reset, και `retries: 1` στο CI). Το secret μένει στο `e2e/.auth/`, που μπαίνει στο `.gitignore`.
  - Φρέσκος κωδικός: helper `e2e/lib/step-up.ts` που περιμένει να παλιώσει ο κωδικός του session πέρα από το παράθυρο του seed (10″), ώστε το φύλλο να εμφανίζεται πάντα, και δίνει κωδικό από το `e2e/lib/totp.ts` (ποτέ τον ίδιο κωδικό δύο φορές στο ίδιο βήμα 30″).
  - Σενάρια: `owner-enroll`, πρώτη σύνδεση → υποχρεωτική εγγραφή → «Πρόσθεσε δεύτερη συσκευή» (το «Αργότερα» μόνο με την επιβεβαίωση)· owner, νέα σύνδεση → κωδικός email → κωδικός 6 ψηφίων → υπενθύμιση δεύτερης συσκευής· από την οθόνη κωδικού → «Χάσατε τη συσκευή σας;»· staff χωρίς εφαρμογή κωδικών, που κάνει καθημερινές ενέργειες (κράτηση, μετακίνηση, ακύρωση) και δεν βλέπει **ποτέ** το φύλλο κωδικού· ο owner προσκαλεί staff (φύλλο κωδικού → επιτυχία) και ο staff συνδέεται· αλλαγή slug (φύλλο κωδικού → επιτυχία) → το παλιό link ανακατευθύνει· «Προσθήκη τώρα» γράφει δεύτερο παράγοντα με άλλο όνομα, και η επόμενη σύνδεση περνά με κωδικό του δεύτερου, χωρίς υπενθύμιση· `owner-devices` προσθέτει συσκευή στις Ρυθμίσεις → Ασφάλεια και την αφαιρεί: φύλλο κωδικού → επιτυχία, η συσκευή φεύγει από τη λίστα, και η «Αφαίρεση» της τελευταίας είναι ανενεργή· αποσύνδεση σε ένα browser context αφήνει το άλλο συνδεδεμένο, ενώ η «Αποσύνδεση από όλες τις συσκευές» (`scope: 'global'`) αποσυνδέει και τα δύο (το άλλο context το βλέπει στο επόμενο `getUser`/refresh).
  - Το `pro-login.spec` του 1.1 ενημερώνεται: ο owner καταλήγει σε `enroll`/`challenge`, ο staff μπαίνει κατευθείαν.

**Κριτήρια εξόδου**

- Έλεγχοι της μέρας 1: το integration test αποδεικνύει ότι νέο verify ανανεώνει το timestamp του `totp` στο `amr` (τοπικά, και με το χέρι στο `anaklo-dev`)· η δυνατότητα trigger στο `auth.mfa_factors` του `anaklo-dev` είναι ελεγμένη και γραμμένη στο ADR-0009 (trigger ή job ανά 5′ στο 1.9).
- Εγγραφή σε πραγματικό iPhone, μέσα στην εγκατεστημένη PWA, με τους «Κωδικούς» του iOS (με εναλλαγή εφαρμογής και reload), και δεύτερη συσκευή με το QR.
- Κάθε κρίσιμη ενέργεια του 1.7 αποτυγχάνει στον server χωρίς φρέσκο κωδικό, και με απευθείας κλήση στο PostgREST ή στην Edge Function, όχι μόνο από το UI. Στο iPhone του dev το φύλλο εμφανίζεται μετά από 5′ και η ενέργεια περνά με τον κωδικό· οι καθημερινές ενέργειες δεν το ανοίγουν ποτέ.
- Αφαίρεση και προσθήκη συσκευής στο dev μέσω της εφαρμογής, με άδεια στο `private.factor_change_grants` και γραμμή στο `audit_log`.
- Το `mfa-reset.mjs` δοκιμασμένο στο dev κατά το runbook: παράγοντες και sessions σβησμένα, άδειες αφαίρεσης και γραμμή στο `audit_log` ανά επιχείρηση, και στην επόμενη σύνδεση εγγραφή → δεύτερη συσκευή.
- Η ανάκληση sessions στην αλλαγή ρόλου περνά με `db:test:dev`, ή ο μηχανισμός της εφεδρείας είναι γραμμένος στο ADR-0009 §19 και δοκιμασμένος στο dev. TOTP ενεργό στο remote dashboard.
- Ο C6 είναι γραμμένος ως απόφαση στα ADR-0005, ADR-0009, στο SPEC §11 και στο CLAUDE.md.

## 1.8 Καρτέλα πελάτη, συγχώνευση, ανωνυμοποίηση

- **Στόχος:** Το «giorgos» βρίσκει τον πελάτη. Η καρτέλα δείχνει στοιχεία, ιστορικό, σημειώσεις, συναινέσεις και απλά στατιστικά. Οι διπλοί συγχωνεύονται με SQL. Ο owner, με φρέσκο κωδικό (C6), ανωνυμοποιεί πελάτη, και όνομα και τηλέφωνο δεν μένουν σε καμία στήλη κειμένου της επιχείρησης. Χωρίς κωδικό των τελευταίων 5′ το `erase_client` απαντά `42501` με hint `aal2_required` ή `fresh_totp_required` και ανοίγει το `StepUpSheet`.
- **Μέρες:** 2,5 (ο φρέσκος κωδικός δεν προσθέτει: ο μηχανισμός είναι στο 1.7)
- **Εξαρτάται από:** 1.3 (`suppression_list`, `messages_log`, tokens), 1.4 (`search_clients`), 1.7 (`private.require_fresh_totp()`, `StepUpSheet`/`withStepUp`).

**Βάση: `0010_client_ops.sql`**

- `client_card(p_business_id, client)`: στοιχεία, ιστορικό, απλοί μετρητές (επισκέψεις, τελευταία επίσκεψη, no-shows). Ποσά σε owner/manager, και σε staff μόνο για τα δικά του ραντεβού, **μηδενισμένα μέσα στο `_impl`**. Οι κανόνες της «μνήμης» μένουν για το `client_memory` (Φάση 2).
- `merge_clients(p_business_id, source, target)`, owner/manager: μεταφέρει ραντεβού και σημειώσεις, βάζει `merged_into_id`, γράφει `audit_log`. **Οι συναινέσεις μένουν στον source**, γιατί το `guard_consent_update` απορρίπτει κάθε αλλαγή πλην του `withdrawn_at` για κάθε ρόλο· οι αναζητήσεις συναίνεσης και «μνήμης» ακολουθούν το `merged_into_id`. Συγχώνευση ανάμεσα σε επιχειρήσεις αδύνατη. Για τον importer της Φάσης 3: `private.merge_clients_core`, χωρίς GRANT, με actor `import`.
- `erase_client(p_business_id, client)`, μόνο owner, με φρέσκο κωδικό: το `_impl` καλεί το `private.require_fresh_totp()` μετά τον έλεγχο συμμετοχής και ρόλου (C6· `42501` με hint `aal2_required` ή `fresh_totp_required`):
  - σβήνει όνομα, τηλέφωνο, email, γενέθλια και `search_text` (το `phone_verified_at` μηδενίζεται από τον trigger), σημειώσεις και συναινέσεις
  - ανακαλεί έμπιστες συσκευές και tokens· μηδενίζει το `messages_log.to_e164` και τα τηλέφωνα των `otp_challenges`
  - γράφει `phone_hmac` στο `suppression_list`, βάζει `erased_at`, γράφει `audit_log`· τα ραντεβού και τα events μένουν, ανώνυμα
- `01_security`, `gen:types`.

**Edge Functions:** καμία.

**Frontend**

- `features/clients`: `ClientSearch` (με το `search_clients`) και `ClientCard` (στοιχεία, ιστορικό, σημειώσεις, συναινέσεις). `EraseDialog` με επιβεβαίωση, μέσω του `withStepUp` του 1.7: σε `aal2_required` ή `fresh_totp_required` ανοίγει το `StepUpSheet`.
- Διακόπτης συναίνεσης: off = `withdrawn_at` στην ενεργή εγγραφή· on = **νέα** εγγραφή με `source = staff_ui` («στην καρέκλα»)· ποτέ αλλαγή σε `purpose` ή `granted`. Το ίδιο ισχύει για το κουτί της φόρμας κράτησης (1.3).

**Tests**

- pgTAP `15_client_ops`: η συγχώνευση μεταφέρει ραντεβού και σημειώσεις και γράφει μία γραμμή audit· οι συναινέσεις μένουν αμετάβλητες και φαίνονται μέσω του target· ανάμεσα σε επιχειρήσεις αδύνατο· το staff δεν συγχωνεύει ούτε ανωνυμοποιεί· `client_card_impl` ως staff δίνει ποσά μόνο για τα δικά του· το suppression κρατά HMAC, όχι απλό hash.
- pgTAP `15_client_ops`, φρέσκος κωδικός στο `erase_client_impl` (όπως στο 1.7): `aal1` → `42501` με hint `aal2_required`· `aal2` με `totp` πριν από 6′ ή με `amr` μόνο `otp` → `fresh_totp_required`, και ο πελάτης μένει ανέγγιχτος· `totp` πριν από 1′ → ανωνυμοποίηση· παράθυρο 0 → πάντα `fresh_totp_required`.
- pgTAP `15_client_ops`, ανωνυμοποίηση: σάρωση του καταλόγου δεν βρίσκει το όνομα ή το τηλέφωνο σε καμία στήλη κειμένου κανενός πίνακα της επιχείρησης (και στα `messages_log`, `otp_challenges`)· `phone_verified_at` = `NULL`· τα ραντεβού μένουν.
- Playwright: αναζήτηση με greeklish· ο owner (session `aal2` από το setup του 1.7, με το παράθυρο του seed και τον helper `e2e/lib/step-up.ts`) ανωνυμοποιεί πελάτη: επιβεβαίωση → εμφανίζεται το φύλλο κωδικού → κωδικός από το `e2e/lib/totp.ts` (`node:crypto`) → επιτυχία. Vitest: το `EraseDialog` περνά από το `withStepUp` (και τα δύο hints → φύλλο → μία επανάληψη· δεύτερη αποτυχία → σφάλμα). Οι περιπτώσεις του server τις ελέγχει το pgTAP παραπάνω.

**Κριτήρια εξόδου**

- Περνά ο έλεγχος του SPEC §13: ο ανωνυμοποιημένος πελάτης δεν εμφανίζεται πουθενά με όνομα ή τηλέφωνο.
- Το `erase_client` αποτυγχάνει στον server χωρίς φρέσκο κωδικό, και με απευθείας κλήση στο PostgREST· από την εφαρμογή, το φύλλο κωδικού οδηγεί σε επιτυχία με μία επανάληψη.
- Owner και manager καλούν το `merge_clients` μέσω του wrapper· το `merge_clients_core` είναι έτοιμο για την εισαγωγή της Φάσης 3.

## 1.9 Παρακολούθηση και τελική πρόβα

- **Στόχος:** Σφάλματα, νεκρά cron jobs και πεσμένη σελίδα κράτησης γίνονται αντιληπτά μέσα σε 15′, χωρίς προσωπικά δεδομένα στις αναφορές και με όλα στην ΕΕ. Κάθε αλλαγή στις συσκευές κωδικών owner/manager που δεν ταιριάζει με άδεια (π.χ. απευθείας στο GoTrue, με κλεμμένο session `aal2`) ανιχνεύεται μέσα σε 5′: ο παράγοντας που προστέθηκε σβήνεται, μια αφαίρεση δεν αναστρέφεται (το secret χάθηκε), και στις δύο περιπτώσεις ανακαλούνται τα sessions και φεύγουν email και push (C6). Όλη η Φάση 1 περνά σε πραγματικές συσκευές.
- **Μέρες:** 2,5 (≈ 1,5 παρακολούθηση και πρόβα· ≈ 1 ανίχνευση, διαγραφή ξένου παράγοντα, ανάκληση sessions και email ασφαλείας, C6)
- **Εξαρτάται από:** 1.5a (jobs, `dispatch`), 1.5b (πραγματικά SMS στην πρόβα), 1.7 (`private.factor_change_grants`, `revoke_user_sessions`, αποτέλεσμα του ελέγχου trigger της μέρας 1), 1.8. Όλα προηγούνται.

**Βάση: `0011_health.sql`**

- `private.health_impl` + `public.health` (μόνο `service_role`): ληγμένα job_runs (dispatch > 15′, auto-complete > 30′, purge > 26ω, ανίχνευση αλλαγών συσκευών κωδικών > 15′). `01_security`.
- `private.mfa_factor_snapshot` (RLS, κανένα GRANT): οι επαληθευμένοι παράγοντες (`auth.mfa_factors`) των owner/manager στον τελευταίο έλεγχο. Το migration το γεμίζει με την τρέχουσα κατάσταση.
- `private.security_events` (RLS, κανένα GRANT): χρήστης, είδος (`factor_added_unauthorized`, `factor_removed_unauthorized`), `factor_id`, `detected_at`, lease και `handled_at` για τον `dispatch`. Τύποι ως `text` + `CHECK`.
- `private.detect_factor_changes_impl()`, που δηλώνει `system` μέσα του:
  - συγκρίνει τους επαληθευμένους παράγοντες των owner/manager με το snapshot
  - κάθε παράγοντας που προστέθηκε ή αφαιρέθηκε πρέπει να ταιριάζει με άδεια στο `private.factor_change_grants` (από το `authorize_factor_change`, το `mfa-reset` της Nous, το `_impl` υποβιβασμού ή τον `dispatch`): αφαίρεση με το ίδιο `factor_id`· προσθήκη όταν το `created_at` του παράγοντα πέφτει μέσα στην ισχύ της άδειας. Η άδεια καταναλώνεται (`matched_at`)
  - αλλαγή χωρίς άδεια → γραμμή στο `private.security_events` και στο `audit_log` (actor `system`) σε κάθε επιχείρηση όπου ο χρήστης είναι owner ή manager, και «σπρώξιμο» του `dispatch` μετά το commit
  - στο τέλος ενημερώνει το snapshot· δεύτερο τρέξιμο χωρίς νέες αλλαγές δεν γράφει τίποτα
- pg_cron ανά 5′ με job_run (`cron.schedule('detect-factor-changes', …)`). Αν ο έλεγχος της μέρας 1 του 1.7 έδειξε ότι το hosted Supabase δέχεται trigger στο `auth.mfa_factors`, η ίδια λογική τρέχει αμέσως από trigger αντί για το job.
- RPCs μόνο για `service_role`: `claim_security_events` (lease, όπως στα μηνύματα) και `record_security_event_result`. Η διαγραφή ενός μη εγκεκριμένου παράγοντα από τον `dispatch` γράφει πρώτα άδεια (πηγή `system`), ώστε να μη σημειωθεί ξανά.

**Edge Functions**

- `health` → 503 όταν κάποιο job έχει λήξει. Sentry EU (Deno) σε κάθε function, με το SDK στο `index.ts`· ο scrubber στο `_shared/observability.ts` σβήνει αριθμούς `+30…`, emails και tokens πριν την αποστολή· ειδοποίηση για delivery reports με segments > 1.
- `dispatch` (1.5a): χειρίζεται και τα `security_events`, με claim και lease:
  - παράγοντας που **προστέθηκε** χωρίς άδεια → διαγραφή με `auth.admin.mfa.deleteFactor`, ανάκληση όλων των sessions του χρήστη (`revoke_user_sessions`), email μέσω Resend στον χρήστη και στους owners της επιχείρησης, push στους owners
  - παράγοντας που **αφαιρέθηκε** χωρίς άδεια → δεν αναστρέφεται (το secret χάθηκε)· ανάκληση sessions και οι ίδιες ειδοποιήσεις. Στην επόμενη σύνδεση, αν δεν μένει κανένας παράγοντας, το `decideAuthRoute` δίνει `enroll`
  - κείμενα email στο `supabase/functions/_shared/security-email-templates.ts` (el/en, με test el = en· εξαίρεση του κανόνα 8, όπως τα `sms-templates` και `push-templates`), στη γλώσσα του παραλήπτη, χωρίς secrets ή κωδικούς· αποστολή από το `mail.anaklo.gr`, με το κλειδί Resend ως secret της function. Push από το `_shared/push-templates.ts`.

**Frontend**

- Sentry EU: στην PWA από την αρχή· στη σελίδα κράτησης lazy μετά την πρώτη απόδοση (πρώτο στη σειρά περικοπών). Το `beforeSend` σβήνει `+30…`, emails, tokens του `/m/` και tokens έμπιστης συσκευής.
- Source maps: ανεβαίνουν στο Sentry κατά το build και **σβήνονται από το `dist` πριν το deploy**· το `build.sourcemap` μένει `hidden` και το `check-secrets` αποτυγχάνει σε κάθε `sourceMappingURL`.
- Uptime ανά 5′ στο `/demo-barber` και στο `/api/functions/v1/health` (κρατά και το Free project ξύπνιο)· κανόνες ειδοποίησης στο Sentry.
- `docs/runbooks/`: πεσμένη σελίδα κράτησης· SMS που δεν φεύγουν· μέλος κλειδωμένο ή με χαμένο κινητό (ο owner αφαιρεί το μέλος ή αλλάζει τον ρόλο του, που ανακαλεί τα sessions του· για χαμένη συσκευή κωδικών το `mfa-reset.md` του 1.7)· μη εγκεκριμένη αλλαγή συσκευής κωδικών (`security-event.md`: επικοινωνία με τον χρήστη από γνωστό κανάλι, νέα σύνδεση, `mfa-reset` αν χρειάζεται).

**Tests**

- pgTAP `16_health`: ένα ληγμένο job εμφανίζεται· οι `anon` και `authenticated` δεν εκτελούν το `health`.
- pgTAP `16_health`, ανίχνευση:
  - επαληθευμένος παράγοντας owner/manager στο `auth.mfa_factors` χωρίς άδεια → ακριβώς ένα `security_event` και `audit_log` με actor `system`· με άδεια → κανένα, και η άδεια καταναλώνεται
  - αφαίρεση χωρίς άδεια → ένα event· ληγμένη άδεια → event· δεύτερο τρέξιμο → κανένα νέο event
  - οι άδειες του `mfa-reset`, του υποβιβασμού και του `dispatch` δεν δίνουν event· παράγοντες μη επαληθευμένοι ή χρηστών που δεν είναι owner/manager αγνοούνται· job_run
  - κανένα GRANT στους νέους πίνακες· οι νέες RPCs μόνο για `service_role`
- Vitest: `observability.test` σβήνει ελληνικά κινητά, emails και tokens· `security-email-templates` el = en· χειρισμός των `security_events` στον `dispatch`, με ψεύτικους clients: προσθήκη → διαγραφή, ανάκληση, email σε χρήστη και owners, push· αφαίρεση → ανάκληση και ειδοποιήσεις, καμία διαγραφή· κάθε event μία φορά.
- Χειροκίνητα στο dev: προσθήκη παράγοντα **απευθείας** στο GoTrue (με session `aal2`, χωρίς την εφαρμογή) → μέσα σε 5′ ο παράγοντας σβήνεται, το session ανακαλείται και φτάνουν email και push.
- Χειροκίνητος πίνακας συσκευών (SPEC §13): Instagram και Facebook in-app σε iOS και Android, Safari, Chrome, εγκατεστημένη PWA με push.

**Κριτήρια εξόδου**

- Αν σταματήσει το cron του dispatch, έρχεται ειδοποίηση μέσα σε 15′. Soak 48 ωρών στο dev, από την αρχή του βήματος: καμία διπλή αποστολή, κανένα ληγμένο job.
- Μη εγκεκριμένη προσθήκη συσκευής κωδικών στο dev σβήνεται, και κάθε μη εγκεκριμένη αλλαγή ανακαλεί τα sessions και ειδοποιεί χρήστη και owner μέσα σε 5′ (ή αμέσως, με trigger). Ο υπολειπόμενος κίνδυνος είναι γραμμένος στο ADR-0009.
- CI πράσινο, με `fn:check`, `test:race` και έλεγχο μεγέθους. Οι ροές 1, 2, 3 και 6 του SPEC §5 περνούν σε πραγματικές συσκευές.

## Κίνδυνοι

| Κίνδυνος                                                                                                                        | Αντιμετώπιση                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Το KYC ή το sender ID αργούν, και δεν υπάρχει ακόμη νομικό πρόσωπο                                                              | 2–3 πάροχοι από τη μέρα 1, υπογράφει ο Μιχάλης (D3). Ο ψεύτικος adapter και οι δοκιμαστικοί αριθμοί κρατούν τα 1.3–1.5a σε κίνηση. Αν ως τη μέρα ~20 δεν υπάρχει πάροχος, τα 1.6–1.8 πάνε πριν το 1.5b (που δεν έχει migration). |
| Σφάλματα ζώνης ώρας, DST και τοπικών μεσανύχτων                                                                                 | Λογική μόνο σε SQL, χωρίς αντίγραφο σε TypeScript. `p_now` ως όρισμα, τοπικό → UTC μία φορά ανά ημερομηνία, fixtures νυχτερινής βάρδιας και `America/New_York`. Η αλλαγή ώρας της 2026-10-25 παρακολουθείται ζωντανά στο dev.    |
| Διπλοκρατήσεις από ταυτόχρονα αιτήματα ή επαναλήψεις                                                                            | Exclusion constraint, advisory lock ανά επιχείρηση και τοπική μέρα, idempotency (άλλο payload με ίδιο κλειδί = σφάλμα). Races στο CI: 20 κρατήσεις, ίδιο κλειδί, μετακίνηση και κράτηση.                                         |
| Χαμένο cookie έμπιστης συσκευής στους in-app browsers                                                                           | Δοκιμή στο 1.1. Με το verification grant η ροή δεν κολλά ποτέ· το κόστος είναι μόνο περισσότερα OTP, που μετριούνται από το `messages_log`.                                                                                      |
| iOS PWA: χωριστή αποθήκευση, push μόνο σε εγκατεστημένη εφαρμογή, ένας service worker ανά scope, reload στην εναλλαγή εφαρμογών | Κωδικός email αντί για magic link, οθόνη «πρόσθεσε πρώτα», δοκιμές του 1.1 (C5), `factorId` στο `sessionStorage`, VAPID ως εφεδρεία. Χωρίς push η δουλειά συνεχίζεται: refetch κάθε 60″.                                         |
| Ένα μέλος δηλώνει στον browser την ταυτότητα άλλου (π.χ. `OneSignal.login('<id του owner>')`) και παίρνει τα push του· το Identity Verification του OneSignal δεν υποστηρίζει το Web SDK | Καμία ταυτότητα στον client: ποτέ `OneSignal.login`/`external_id`, ποτέ Identity Verification στο web app. Αποστολή μόνο με `include_subscription_ids` (Vitest στο `buildPushPayload`)· το δέσιμο συνδρομής ↔ χρήστη στον server (1.1: η συσκευή που καλεί· 1.5a: `push_subscriptions` με `UNIQUE`, RLS, RPCs και pgTAP)· `optOut` και `unregister` σε κάθε αποσύνδεση. Βήμα 10 της δοκιμής C5. |
| Μένουν ~19 KB στον προϋπολογισμό της σελίδας κράτησης                                                                           | Namespaces i18n, lazy chunks, ημερομηνίες μόνο με `Intl`, κατάλογος από τον Worker, χωρίς TanStack Query στη σελίδα, Preact ως τελευταία λύση. Έλεγχος μεγέθους σε κάθε PR.                                                      |
| Ο πάροχος στέλνει σιωπηλά UCS-2, το link δεν πατιέται ή το iOS δεν προτείνει τον κωδικό                                         | Κριτήρια C4 με `sms-probe` σε πραγματικά δίκτυα πριν την επιλογή. Ρητό GSM-7 στο αίτημα. Segments από τα delivery reports, με ειδοποίηση όταν ξεπερνούν το 1.                                                                    |
| SMS pumping (ψεύτικα OTP που φουσκώνουν το κόστος)                                                                              | Μόνο +3069, OTP μόνο με ελεύθερη ώρα, όρια ανά αριθμό, IP, επιχείρηση και ημέρα, πλατφορμικό όριο και διακόπτης, μυστικό proxy, σκληρό όριο στον πάροχο (C4).                                                                    |
| Διπλές αποστολές, cron ή pg_net που αποτυγχάνουν σιωπηλά, παύση του Free project                                                | Dedupe keys και leases· άγνωστη έκβαση δεν ξαναστέλνεται. `job_runs` → `health` 503 → uptime ανά 5′, που κρατά και το project ξύπνιο. Supabase Pro πριν τον πιλότο (Φάση 3).                                                     |
| Owner κλειδωμένος έξω από το TOTP                                                                                               | Υποχρεωτική οθόνη «Πρόσθεσε δεύτερη συσκευή» μετά τον πρώτο παράγοντα, banner και υπενθύμιση όσο λείπει. Οθόνη «Χάσατε τη συσκευή σας;». Reset μόνο από τη Nous, με επαλήθευση ταυτότητας (email και κλήση στο γνωστό τηλέφωνο), `mfa-reset.mjs`, runbook και `audit_log`. Η αφαίρεση του τελευταίου παράγοντα απορρίπτεται (`authorize_factor_change`). Το staff δεν χρειάζεται TOTP. |
| Κοινό ή χαμένο κινητό με ανοιχτό session, μέλος που αποχωρεί                                                                    | Αποσύνδεση μόνο της συσκευής και «από όλες τις συσκευές», 30 μέρες αδράνειας, access token 1 ώρας. Αλλαγή ρόλου ή αφαίρεση ανακαλεί όλα τα sessions στην ίδια συναλλαγή· ο ρόλος διαβάζεται ζωντανά, ποτέ από το JWT. |
| Edge Function με `service_role` που παρακάμπτει ελέγχους (`invite-member`, `manage-factors`)                                    | Έλεγχος ρόλου και φρέσκου κωδικού με RPC ως ο χρήστης **πριν** από το `service_role`, με Vitest (`invite-member`, `manage-factors`) και pgTAP (`can_manage_members`, `authorize_factor_change`). Γενικά: `service_role` μόνο μέσω RPC, χωρίς GRANT πινάκων στα νέα δεδομένα.                                                                     |
| Κλεμμένο ή ξεχασμένο ανοιχτό session owner κάνει κρίσιμη ενέργεια (ανωνυμοποίηση, μέλη, ταυτότητα)                             | Φρέσκος κωδικός (C6) μέσα σε κάθε κρίσιμο `_impl`, όχι μόνο στο UI· `business_members` μόνο μέσω RPC, ώστε να μην παρακάμπτεται από τον πίνακα. pgTAP για κάθε `_impl` (`aal1`, κωδικός 6′, μόνο `otp`, παράθυρο 0).                                                     |
| Το timestamp του `totp` στο `amr` δεν ανανεώνεται σε νέο verify, άρα ο φρέσκος κωδικός δεν μπορεί να ελεγχθεί                   | Ελεγμένο στον κώδικα του Supabase Auth (`models/amr.go`, `AddClaimToSession`: upsert του `mfa_amr_claims.updated_at` σε κάθε verify). Integration test τη μέρα 1 του 1.7 στο αποκωδικοποιημένο JWT· αν αποτύχει, σταματάμε και ρωτάμε πριν από οτιδήποτε άλλο. |
| Κλεμμένο session `aal2` αλλάζει συσκευές κωδικών απευθείας στο GoTrue. Το Supabase Pro δεν ελέγχει φρεσκάδα εκεί και δεν έχει hook άρνησης (το MFA Verification Attempt υπάρχει μόνο σε Teams/Enterprise) | Η εφαρμογή περνά μόνο από `authorize_factor_change`/`manage-factors` με φρέσκο κωδικό. Ανίχνευση ανά 5′ (ή αμέσως με trigger στο `auth.mfa_factors`, αν το επιτρέπει το hosted Supabase: έλεγχος τη μέρα 1 του 1.7) και αντίδραση στο 1.9: διαγραφή του νέου παράγοντα, ανάκληση όλων των sessions, email σε χρήστη και owner, push στον owner. **Υπολειπόμενος κίνδυνος**, γραμμένος στο ADR-0009: έως 5′ με παράγοντα του επιτιθέμενου πριν σβηστεί· μια αφαίρεση χωρίς άδεια δεν αναστρέφεται (μόνο ανάκληση και ειδοποίηση). |
| Το remote dev αποκλίνει από το repo· το `db:reset:dev` σβήνει provisioning και ίσως Vault                                       | Σταθερή σειρά στο τέλος κάθε βήματος (`db:push` → `secrets:dev` → `db:test:dev` → `deploy:dev`· μετά από `db:reset:dev` μπαίνει και `provision:dev` αμέσως μετά το `secrets:dev`). Το `secrets:dev` κάνει upsert, τα cron jobs τα ξαναφτιάχνουν τα migrations. Το `deploy-dev` ελέγχει το project ref. Ποτέ `config push`· λίστα dashboard στο `SETUP.md`. |
| Υπέρβαση χρόνου                                                                                                                 | 37 + 3 μέρες (μαζί τα +2 του C6), με την αργία της 28/10 μέσα. Σύγκριση πραγματικού και πλάνου στο τέλος κάθε βήματος. Σειρά περικοπών C1, σε ό,τι δεν έχει ακόμη υλοποιηθεί· τα κλεισίματα δεν κόβονται.                                            |

## Αναβάλλονται

| Τι                                                                                                       | Πότε                         |
| -------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Realtime ανάμεσα στα κινητά του προσωπικού                                                               | Φάση 3                       |
| Καθημερινό email στον owner (πρόγραμμα 7 ημερών)                                                         | Φάση 3, πριν τον πιλότο      |
| UI συγχώνευσης πελατών (η SQL είναι στο 1.8)                                                             | Φάση 3, μαζί με τον importer |
| Offline cache «Σήμερα + 7 μέρες» και banner «νέα έκδοση» (ο service worker της Φάσης 1 δεν κρατά τίποτα) | Φάση 3                       |
| Prod project (με «Inactivity timeout» = 720h και κενό «Time-box user sessions» στο Auth), squash σε baseline, backups και δοκιμαστική επαναφορά | Φάση 3                       |
| Όροι, πολιτική απορρήτου, πρότυπο DPA, `subprocessors.md` (το `policy_version` υπάρχει από το 1.3)       | Φάση 3                       |
| Οθόνη κόστους SMS για τον owner (τα δεδομένα γράφονται από το 1.5) και UI προτιμήσεων ειδοποιήσεων       | Φάση 3                       |
| Εξαγωγές δεδομένων (με φρέσκο κωδικό, C6: `private.require_fresh_totp()` στο `_impl` ή στο RPC που καλεί πρώτα η Edge Function) | Φάση 3                       |
| `deactivate_business` (τερματισμός λογαριασμού, owner με φρέσκο κωδικό, C6)                              | Φάση 5                       |
| Υπενθύμιση 2ω πριν και πιο έντονο push για κοντινές κρατήσεις                                            | v1                           |
| UI για πολλές υπηρεσίες σε μία online κράτηση                                                            | v1                           |
| Email επιβεβαίωσης σε πελάτες                                                                            | v1                           |
| Κινητά εκτός +3069                                                                                       | v1                           |
| Drag & drop και εβδομαδιαία προβολή                                                                      | v1                           |
| Λίστα αναμονής, one-tap rebook, αίτημα κριτικής, γενέθλια                                                | Φάση 2 / v1                  |
| Επεξεργασία θέματος, λογότυπου και κατηγοριών, φωτογραφίες προσωπικού                                    | Φάση 5 (onboarding)          |
| UI manager πέρα από πρόσκληση, αφαίρεση και αλλαγή ρόλου (1.7), μεταβίβαση owner                         | Μετά το MVP                  |
| Send Email Hook για πλήρως μεταφρασμένα emails του Auth                                                  | Πριν την εμπορική διάθεση    |
| Πλήρη αγγλικά κείμενα (τα κλειδιά μένουν συγχρονισμένα)                                                  | Πριν την εμπορική διάθεση    |
| «Τι νέο υπάρχει» και CHANGELOG                                                                           | Από τον πιλότο (Φάση 4)      |
| Σκούρο θέμα                                                                                              | v1                           |
