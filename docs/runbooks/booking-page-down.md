# Runbook: η σελίδα κράτησης δεν ανοίγει

- **Κατάσταση:** βήμα 1.9 (τοπικά). Το uptime που σημαίνει συναγερμό και οι πραγματικές διευθύνσεις (`anaklo.gr`, `dev.anaklo.gr`) έρχονται στο 1.10.
- **Πηγές:** ADR-0008 (Worker, `/api` proxy, `/<slug>`), contract `docs/plans/contracts/1.9-health-detection.md` §3.1 και §4.1, plan `docs/plans/phase-1.md` «## 1.9».
- **Εργαλεία:** ο browser, το `health` (`/api/functions/v1/health`), ανάγνωση στη βάση (μόνο `select`), το dashboard του Supabase και του Cloudflare.

## 1. Σήμα

- Το uptime (1.10) χτυπά σε `/<slug>` (π.χ. `/demo-barber`) ή σε `/api/functions/v1/health`.
- Μήνυμα ή τηλέφωνο από επιχείρηση: «οι πελάτες δεν μπορούν να κλείσουν».

Πρώτα γράψε **τι** δεν δουλεύει, **για ποιον** (μία επιχείρηση ή όλες) και **από πότε**.

## 2. Έλεγχοι, με αυτή τη σειρά

1. **Η σελίδα.** Άνοιξε `https://<host>/<slug>` σε παράθυρο ιδιωτικής περιήγησης. Σωστό: 200 με HTML και τον τίτλο της επιχείρησης. Ένα 307 ή μια σελίδα «Δεν βρέθηκε η σελίδα κράτησης» σημαίνει άλλο πρόβλημα από ένα 5xx (βλ. βήμα 5).
2. **Το health.** `https://<host>/api/functions/v1/health` (τοπικά `http://localhost:5173/api/functions/v1/health`):
   - 200 `{ "ok": true, … }`: οι functions, το μυστικό του proxy και η βάση απαντούν. Το πρόβλημα είναι πιο κοντά στη σελίδα (Worker, DNS, slug).
   - 503 με `checks`: ποιο check είναι `stale`; Ένα job που δεν τρέχει (π.χ. `dispatch`) δεν ρίχνει τη σελίδα κράτησης, αλλά δείχνει ότι η βάση ή το pg_cron έχουν πρόβλημα. Για `dispatch`/`dispatch_sweep` → `sms-not-sending.md`· για `security_events` → `security-event.md`.
   - 503 `database_unavailable`: το `health` δεν πήρε έγκυρη απάντηση από τη βάση. Δεν σημαίνει μόνο ότι η βάση δεν απαντά: πρώτα διάβασε τη γραμμή `health_unavailable` στο log της function `health` (Supabase → Edge Functions → `health` → Logs· τοπικά `docker logs supabase_edge_runtime_anaklo`). Το `code` της λέει τι συνέβη:
     - `timeout`, `exception` ή `rpc_error`: η βάση δεν απάντησε μέσα σε 5″ ή η σύνδεση κόπηκε → βήμα 3·
     - `PGRST202`: το RPC `health` δεν υπάρχει στη βάση, δηλαδή οι functions ανέβηκαν πριν από το migration `0011` (σειρά deploy: migration → Edge Functions → frontend). Το project είναι πάνω· λείπει το `db:push`·
     - `invalid_result`: η βάση απάντησε, αλλά όχι με το σχήμα που περιμένει η function (π.χ. νέο job στο `private.health_jobs` ή στο `HEALTH_CHECK_NAMES` χωρίς να ανέβει και το άλλο μισό): migration και functions δεν είναι στην ίδια έκδοση → deploy και των δύο·
     - άλλος κωδικός (π.χ. `42501`, `PGRST301`): το RPC απορρίφθηκε (δικαιώματα ή κλειδί του `service_role`)· έλεγξε τα μυστικά (`secrets:dev`) και το allow-list του `01_security`.
   - 403 `forbidden` ή 500 `proxy_not_configured`: το `PROXY_SECRET` του Worker και των functions διαφέρει ή λείπει (`secrets:dev`, docs/SETUP.md §4).
3. **Το project του Supabase.** Dashboard → το project: είναι σε παύση (το Free σταματά μετά από αδράνεια) ή σε συντήρηση; Η περιοχή (EU) έχει περιστατικό στο status page του Supabase;
4. **Worker, route, DNS (Cloudflare).** Dashboard → Workers: το τελευταίο deploy, τα σφάλματα, το route του host. DNS του `anaklo.gr`: η εγγραφή δείχνει στον Worker;
5. **Η επιχείρηση.** Μόνο μία επιχείρηση επηρεάζεται; Ανάγνωση:

   ```sql
   select b.slug, b.booking_enabled, b.messaging_enabled
   from public.businesses b where b.slug = '<slug>';
   -- the slug the client typed may be an OLD address of a business (1.7)
   select a.slug as old_slug, b.slug as current_slug
   from public.business_slug_aliases a
   join public.businesses b on b.id = a.business_id where a.slug = '<slug>';
   ```

   - `booking_enabled = false`: η σελίδα σκόπιμα δεν δέχεται κρατήσεις. Το αλλάζει μόνο ο owner από τις Ρυθμίσεις.
   - Η επιχείρηση άλλαξε slug (1.7): το παλιό κάνει 307 στο νέο, και αυτό είναι σωστό.
   - Ο πλατφορμικός διακόπτης SMS (`private.platform_settings.sms_enabled = false`) σταματά τους κωδικούς επιβεβαίωσης, άρα και τις νέες online κρατήσεις: `select sms_enabled, push_enabled from private.platform_settings;`
6. **Πρόσφατο deploy.** Αν το πρόβλημα ξεκίνησε μαζί με ένα deploy: rollback του Worker στην προηγούμενη έκδοση (Cloudflare → Workers → Deployments). Το migration **δεν** γυρίζει πίσω· διόρθωση με νέο migration (CLAUDE.md, Κανόνες βάσης).
7. **Επικοινωνία με την επιχείρηση.** Τηλέφωνο στο νούμερο που έχουμε ήδη (`businesses.phone_e164`): τι συμβαίνει, ότι το κοιτάμε, και ότι μπορεί να κλείνει ραντεβού από την εφαρμογή επαγγελματία (που δεν περνά από τη σελίδα κράτησης) μέχρι να διορθωθεί.

## 3. Καταγραφή

Ticket: πότε ξεκίνησε, ποιοι επηρεάστηκαν, τι βρέθηκε σε κάθε βήμα του §2, τι έγινε και πότε επανήλθε.

## 4. Ποτέ

- Ποτέ αλλαγές στη βάση με το χέρι (SQL editor, `update`) για να «ξεκολλήσει» κάτι. Μόνο μέσω της εφαρμογής, των scripts ή νέου migration.
- Ποτέ `booking_enabled` ή άλλη ρύθμιση επιχείρησης χωρίς τον owner.
- Ποτέ αλλαγή μυστικών στο dashboard: μόνο `npm run secrets:dev` (και το αντίστοιχο του prod).

## Τοπική πρόβα

Με το τοπικό stack (`npm run db:start`, `npm run dev`):

1. `http://localhost:5173/demo-barber` → 200 και η σελίδα της επιχείρησης.
2. `http://localhost:5173/api/functions/v1/health` → 200 με έξι checks.
3. Σταμάτησε τη βάση (`npm run db:stop`): η σελίδα γράφει «Δεν φόρτωσε η σελίδα» και το health δεν απαντά. `npm run db:start` → επανέρχονται.
