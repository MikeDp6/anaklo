# Runbook: τα SMS (ή τα push) δεν φεύγουν

- **Κατάσταση:** βήμα 1.9 (τοπικά, ψεύτικος πάροχος SMS και push). Ο πραγματικός πάροχος SMS, το υπόλοιπό του και οι αναφορές παράδοσης έρχονται στο 1.10.
- **Πηγές:** SPEC §12, ADR-0007 (GSM-7), ADR-0010 (push), contract `docs/plans/contracts/1.5-messaging.md` (§2–§3, D22/D23), contract `docs/plans/contracts/1.9-health-detection.md` §4.2.
- **Εργαλεία:** το `health`, ανάγνωση στο `public.messages_log`, `private.job_runs` και `net._http_response` (μόνο `select`), τα logs των Edge Functions.

## 1. Σήμα

- Το health δίνει 503 με `dispatch` ή `dispatch_sweep` stale.
- Παράπονο επιχείρησης ή πελάτη: «δεν ήρθε το SMS» (κωδικός, επιβεβαίωση, υπενθύμιση).
- Πολλές γραμμές `queued` που δεν φεύγουν, ή `failed`/`unknown` στο `messages_log`.

## 2. Πώς φεύγει ένα μήνυμα

Κάθε SMS και push είναι μια γραμμή στο `public.messages_log`. Όσα προκαλεί ο πελάτης (κωδικός, επιβεβαίωση, ακύρωση/αλλαγή από το link) τα στέλνουν αμέσως οι `public-booking`/`manage`. Όλα τα άλλα τα στέλνει η Edge Function `dispatch`, που την καλεί η βάση (pg_net) μετά από κάθε ενέργεια και το job `dispatch-sweep` κάθε 5′. Μια γραμμή περνά από `queued` → `sending` → `sent`/`failed`/`cancelled`/`unknown`, και **δεν στέλνεται ποτέ δεύτερη φορά**.

## 3. Διάγνωση

1. **Τρέχει ο dispatcher;**

   ```sql
   select job, ok, error, started_at, finished_at, rows_affected
   from private.job_runs
   where job in ('dispatch', 'dispatch_sweep')
   order by finished_at desc limit 10;
   ```

   - Καμία πρόσφατη γραμμή `dispatch_sweep`: το pg_cron δεν τρέχει (`select jobname, active from cron.job;`). Ένα job με `active = false` το ενεργοποιεί μόνο migration ή ο Μιχάλης, ποτέ «στα γρήγορα».
   - `dispatch_sweep` με `error = 'dispatch_not_configured'`: λείπουν τα `dispatch_url`/`dispatch_secret` από το Vault (`secrets:dev`).
   - Γραμμές `dispatch_sweep` αλλά καμία `dispatch`: η βάση καλεί, η function δεν απαντά σωστά. Δες τις απαντήσεις του pg_net:

     ```sql
     select id, status_code, left(content, 120) as content, created
     from net._http_response order by created desc limit 10;
     ```

     403 = το `DISPATCH_SECRET` της function διαφέρει από το Vault `dispatch_secret`· 500 `not_configured` = λείπει μεταβλητή της function (από το 1.9 και `EMAIL_PROVIDER`/`SUPPORT_EMAIL`)· 404 = η function δεν έχει γίνει deploy.
   - `dispatch` με `ok = false`: το `error` είναι SQLSTATE ή κωδικός (`invalid_claim`, `42883` = λείπει function, άρα migration που δεν έτρεξε).
2. **Τι έγινε η συγκεκριμένη γραμμή;**

   ```sql
   select created_at, channel, template, category, status, error, attempts, scheduled_for, provider
   from public.messages_log
   where business_id = '<business id>'
   order by created_at desc limit 20;
   ```

   | `error` | Σημαίνει | Ενέργεια |
   |---|---|---|
   | `rate_limited` | Όριο ανά τηλέφωνο ή ανά επιχείρηση τη μέρα (UTC). Η ενέργεια του πελάτη πέτυχε, το SMS όχι. | Συνήθως τίποτα (προστασία από κατάχρηση). Αν επαναλαμβάνεται για μία επιχείρηση, έλεγξε τα όρια του `platform_settings` με τον Μιχάλη. |
   | `budget_exceeded` | Ο μηνιαίος προϋπολογισμός SMS της επιχείρησης τελείωσε (μόνο υπενθυμίσεις/μάρκετινγκ). | Ενημέρωσε τον owner· αλλαγή ορίου μόνο με την έγκρισή του. |
   | `messaging_disabled` | Η επιχείρηση έχει κλειστές τις υπενθυμίσεις/μάρκετινγκ (`messaging_enabled = false`). | Το ανοίγει μόνο ο owner. |
   | `import_reminders_off` | Ραντεβού από εισαγωγή, και το Anaklo δεν είναι ο αποστολέας υπενθυμίσεων. | Σωστό, εκτός αν η επιχείρηση το αλλάξει. |
   | `not_mobile` | Σταθερό +30: δεν δέχεται SMS. | Ο πελάτης δίνει κινητό. |
   | `suppressed` | Ο πελάτης ζήτησε να μη λαμβάνει (ή ανωνυμοποιήθηκε). | Τίποτα. Ποτέ αφαίρεση από τη λίστα χωρίς γραπτό αίτημα του πελάτη. |
   | `expired` | Πέρασε η προθεσμία του μηνύματος (π.χ. υπενθύμιση μέσα στις ώρες ησυχίας, κωδικός που έληξε). | Τίποτα· το παλιό μήνυμα δεν έχει πια νόημα. |
   | `superseded` | Το ραντεβού άλλαξε ή ακυρώθηκε πριν φύγει το μήνυμα. | Τίποτα. |
   | `no_recipient` | Ο πελάτης δεν έχει τηλέφωνο (ή το push δεν έχει παραλήπτη). | Τίποτα. |
   | `not_a_member`, `no_subscription` | Push σε κάποιον που δεν είναι πια μέλος ή δεν έχει συσκευή. | Τίποτα· η συσκευή γράφεται ξανά από τις Ρυθμίσεις → Ειδοποιήσεις. |
   | `recipient_not_allowed` | Το dev στέλνει μόνο στη λίστα `SMS_ALLOWED_RECIPIENTS`. | Σωστό στο dev. |
   | `provider_not_configured` | Push σε συσκευή που ο τρέχων αποστολέας δεν υποστηρίζει. | Δες ADR-0010 (OneSignal ή VAPID). |
   | `unknown` / `lease_expired` | Ο αποστολέας πέθανε ή δεν απάντησε: **μπορεί** να στάλθηκε. | Απόφαση με το χέρι (§4). |
   | `failed` με `http_…`, `timeout`, `network` | Ο πάροχος αρνήθηκε ή δεν απάντησε. | Δες τον πάροχο (§3.4). |
3. **Διακόπτες και όρια:** `select sms_enabled, push_enabled, sms_daily_cap, sms_monthly_cap from private.platform_settings;`. Με `sms_enabled = false` ή γεμάτο το ημερήσιο/μηνιαίο όριο οι γραμμές **μένουν** `queued` (δεν ακυρώνονται) και φεύγουν όταν ανοίξει ο διακόπτης ή αλλάξει η μέρα, όσο δεν έχει περάσει η προθεσμία τους.
4. **Ο πάροχος (1.10):** κατάσταση της υπηρεσίας, υπόλοιπο λογαριασμού, αποκλεισμένος αποστολέας. Τοπικά ο ψεύτικος πάροχος γράφει κάθε SMS στο `docker logs -f supabase_edge_runtime_anaklo` (`fake-sms`, με κρυμμένο αριθμό).

## 4. `unknown`: απόφαση με το χέρι

Μια γραμμή `unknown` **ποτέ** δεν ξαναστέλνεται αυτόματα (D22/D23 του 1.5): μπορεί να έφτασε, και ένα δεύτερο SMS θα ήταν διπλό. Αν ο πελάτης λέει ότι δεν το πήρε και το μήνυμα έχει ακόμη νόημα (π.χ. επιβεβαίωση ραντεβού που δεν έγινε ακόμη):

- η επιχείρηση ενημερώνει τον πελάτη (τηλέφωνο), ή
- ο πελάτης ζητά ξανά κωδικό από τη σελίδα κράτησης (νέα γραμμή, όχι επανάληψη της παλιάς).

Σημείωσε στο ticket ποια γραμμή, τι αποφασίστηκε και γιατί.

## 5. Ποτέ

- Ποτέ αλλαγή του `status` μιας γραμμής με το χέρι (π.χ. `unknown` → `queued`): θα στελνόταν ξανά.
- Ποτέ νέα γραμμή στο `messages_log` με SQL.
- Ποτέ αποστολή SMS από το dashboard του παρόχου σε πελάτη χωρίς ticket και έγκριση της επιχείρησης.
- Ποτέ τηλέφωνα πελατών στο ticket ή σε chat: μόνο το id της γραμμής.

## Τοπική πρόβα

1. Στην εφαρμογή επαγγελματία: Ρυθμίσεις → Ειδοποιήσεις → «Δοκιμαστική ειδοποίηση» (ή ακύρωση ραντεβού με «Ενημέρωση με SMS»).
2. `docker logs -f supabase_edge_runtime_anaklo`: μια γραμμή `fake-push` (ή `fake-sms`).
3. `docker exec supabase_db_anaklo psql -U postgres -c "select template, channel, status, error from public.messages_log order by created_at desc limit 5"` → `sent`.
4. Βγάλε το `DISPATCH_SECRET` από το `.env.local`, `npm run db:stop` → `npm run db:start`: η επόμενη δοκιμή μένει `queued`, το `net._http_response` δείχνει 500 και σε ≤ 15′ το health δίνει 503 `dispatch`. Βάλε το πίσω και ξαναξεκίνα το stack.
