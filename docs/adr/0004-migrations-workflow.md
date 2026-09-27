# ADR-0004: Ροή migrations και περιβάλλοντα

- Κατάσταση: αποδεκτό
- Ημερομηνία: 2026-09-27

## Πλαίσιο
Στο SPEC v0.3 ο χρήστης έτρεχε τα migrations με το χέρι, και αυτό δημιουργούσε τρία προβλήματα:
- Αν εκτελεστούν από τον SQL editor, δεν γράφονται στο `supabase_migrations.schema_migrations`, οπότε η βάση και το repo αποκλίνουν χωρίς να το καταλάβει κανείς.
- Ο κανόνας «ποτέ αλλαγή σε migration που έτρεξε» από την πρώτη μέρα γεμίζει το repo με διορθωτικά αρχεία πριν υπάρξουν δεδομένα.
- Το pgTAP θέλει μια βάση χτισμένη από τα migrations.

## Απόφαση
1. **Μόνο Supabase CLI**, μέσα από npm scripts, ποτέ από τον SQL editor:

   | Εντολή | Τι κάνει |
   |---|---|
   | `npm run db:start` | Ξεκινά το τοπικό stack (Docker Desktop + WSL2) |
   | `npm run db:reset` | Εφαρμόζει όλα τα migrations και το `seed.sql` στην τοπική βάση |
   | `npm run db:test` | Τρέχει τα pgTAP tests (`supabase/tests/*.test.sql`) |
   | `npm run db:push` | Στέλνει τα migrations στο συνδεδεμένο remote project (χωρίς seed) |
   | `npm run gen:types` | Παράγει τους τύπους TypeScript από την τοπική βάση |

2. **Ονόματα αρχείων:** αριθμημένα `0001_<name>.sql`. Δεν τα ανακατεύουμε με timestamps.
3. **Μέχρι να μπουν τα πρώτα πραγματικά δεδομένα** τα migrations αλλάζουν ελεύθερα:
   - Τοπικά ξαναχτίζεις με `db:reset`.
   - Στο remote dev, ένα migration που έχει ήδη σταλεί **δεν** ξαναστέλνεται με `db:push`, γιατί το push κρίνει μόνο από τον αριθμό έκδοσης και το προσπερνά αθόρυβα. Εκεί χρειάζεται `npm run db:reset:dev` (`supabase db reset --linked`). Το script αρνείται να τρέξει αν το συνδεδεμένο project δεν είναι το `SUPABASE_DEV_PROJECT_REF`.
   - Πριν μπουν πραγματικά δεδομένα: squash σε ένα baseline (`0001_baseline.sql`), ξαναχτίζεται το dev (ή `supabase migration repair` για το ιστορικό) και γίνεται το πρώτο push στο prod.
   - Από εκεί και πέρα τα migrations είναι **αμετάβλητα**.
4. Κάθε νέος πίνακας έρχεται στο ίδιο αρχείο με το RLS, τις πολιτικές και τα ρητά GRANT του.
   - Το `0001` ανακαλεί ρητά τα προεπιλεγμένα δικαιώματα: global για το `EXECUTE` του PUBLIC, και ανά schema για τους ρόλους του API. Έτσι το αποτέλεσμα είναι ίδιο τοπικά, στο CI και στο cloud, όποιες κι αν είναι οι προεπιλογές του CLI.
   - Τοπικά ισχύει επιπλέον `auto_expose_new_tables = false` στο `config.toml`.
   - Το `01_security.test.sql` κρατά allow-lists δικαιωμάτων. Ένα GRANT που λείπει ή περισσεύει αποτυγχάνει ήδη στο `db:test`.
5. **Expand/contract:** πρώτα προσθέτουμε. Αφαίρεση ή μετονομασία γίνεται μόνο σε επόμενη έκδοση, όταν κανένας client δεν χρησιμοποιεί πια το παλιό. Αλλαγή που σπάει μια RPC γίνεται με νέο όνομα (`_v2`).
6. **Σειρά deploy:** migration → Edge Functions → frontend.
7. **CI (GitHub Actions, Linux):** σε κάθε PR τρέχουν με τη σειρά:
   - `supabase start` (εφαρμόζει migrations και seed)
   - `supabase test db`
   - `npm run check:types` (οι τύποι της βάσης στο repo πρέπει να είναι ενημερωμένοι)
   - Playwright
8. **Περιβάλλοντα:**
   - `local` (Docker)
   - `dev`: Supabase Free, `anaklo-dev`, EU/eu-west-1, μόνο συνθετικά δεδομένα
   - `prod`: Supabase Pro, EU, πριν μπουν τα πρώτα πραγματικά δεδομένα
9. Το `seed.sql` περιέχει μόνο συνθετικά δεδομένα (επιχείρηση «demo-barber») και δεν στέλνεται ποτέ στο prod.

## Συνέπειες
- Όταν γράφεται ένα migration, ο χρήστης ενημερώνεται: «τρέξε `npm run db:push`».
- Backups: 7 ημέρες στο Pro, προαιρετικά και εβδομαδιαίο κρυπτογραφημένο dump. Όχι «30 ημέρες» στο πλάνο του Supabase.
