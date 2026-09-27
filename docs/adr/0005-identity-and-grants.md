# ADR-0005: Ταυτότητα, RLS και δικαιώματα

- Κατάσταση: αποδεκτό
- Ημερομηνία: 2026-09-27
- Αναθεώρηση: 2026-09-28 (φρέσκος κωδικός στις κρίσιμες ενέργειες και `business_members` μόνο μέσω RPC, §8)

## Πλαίσιο
Από 30/5/2026 τα νέα Supabase projects δεν εκθέτουν πίνακες στο Data API χωρίς ρητό `GRANT`. Όταν εμφανιστεί το πρώτο «permission denied», η εύκολη αντίδραση είναι το `grant all … to anon`, που εκθέτει τα πάντα.

Επιπλέον, τα FK δεν ελέγχονται από το RLS, και το `service_role` το παρακάμπτει εντελώς.

## Απόφαση
1. **`auth.users` = μόνο προσωπικό και ιδιοκτήτες.**
   - Οι πελάτες **δεν** είναι χρήστες Auth. Είναι γραμμές στο `clients` της κάθε επιχείρησης.
   - Επαληθεύονται με OTP ή έμπιστη συσκευή, ανά επιχείρηση (ADR-0006).
   - **Signup κλειστό** (`[auth] enable_signup = false` στο `config.toml` και ίδια ρύθμιση στο dashboard κάθε project). Το `[auth.email] enable_signup` μένει `true`: παρά το όνομά του ανοίγει/κλείνει όλο τον πάροχο email, μαζί με τη σύνδεση.
     - Κανείς δεν φτιάχνει λογαριασμό μόνος του.
     - Οι owners μπαίνουν με το script provisioning της Nous (ADR-0009 §8) μέχρι το onboarding της Φάσης 5.
     - Το προσωπικό μπαίνει με πρόσκληση από Edge Function με `service_role`, μόνο από owner με φρέσκο κωδικό (§8· 1.7, μετά το TOTP).
     - Ένας ξένος λογαριασμός δεν βλέπει τίποτα λόγω RLS, αλλά γεμίζει το `auth.users` και ανοίγει δρόμο για spam email.
2. **Συμμετοχή:**
   - Ποιος ανήκει σε ποια επιχείρηση ορίζεται στο `business_members(business_id, user_id, role, staff_id?)`.
   - Βοηθητικές functions στο schema `private`, που δεν εκτίθεται. Είναι `stable security definer set search_path = ''`.
   - **Στις πολιτικές** χρησιμοποιούνται μόνο οι εκδοχές που επιστρέφουν σύνολο και δεν εξαρτώνται από τη γραμμή:
     - `business_id in (select private.my_business_ids())`
     - `business_id in (select private.my_business_ids_with_role(array[...]))`
     - `staff_id in (select private.my_staff_ids())`

     Το `(select private.is_member(business_id))` θα υπολογιζόταν ξανά για κάθε γραμμή.
   - Οι boolean εκδοχές (`is_member`, `has_role`, `my_staff_id`) χρησιμοποιούνται μέσα σε functions και triggers.
3. **Απομόνωση στη βάση:**
   - `business_id not null` σε κάθε πίνακα
   - `unique (business_id, id)` στους γονικούς
   - **σύνθετα FK** παντού
   - pgTAP test: εγγραφή που δείχνει σε δεδομένα άλλης επιχείρησης αποτυγχάνει ακόμη και ως `service_role`
4. **Ρητά GRANT ανά πίνακα**, στο ίδιο migration:
   - `anon`: τίποτα σε πίνακες.
   - `authenticated`: μόνο όσα χρειάζεται η εφαρμογή επαγγελματία, πάντα μαζί με RLS.
   - Όπου μια στήλη δεν πρέπει να αλλάζει από την εφαρμογή, το UPDATE δίνεται **ανά στήλη**. Το RLS λέει ποιες γραμμές, το GRANT ποιες στήλες. Παραδείγματα:
     - `clients`: όχι provenance, συγχώνευση, ανωνυμοποίηση, `phone_verified_at`
     - `client_notes`: μόνο `body`
     - `client_consents`: μόνο `withdrawn_at`
     - `businesses`: όχι `slug`, `timezone`, `currency`, `vertical`, ούτε για τον owner. Τα τρία πρώτα αλλάζουν μόνο με RPC του owner με φρέσκο κωδικό (`change_business_identity`, §8, ADR-0009, βήμα 1.7), που χειρίζεται τις συνέπειες (παλιά links, τοπική ώρα των μελλοντικών ραντεβού, νόημα των ποσών). Το `vertical` γράφεται μόνο στη δημιουργία και δεν αλλάζει στη Φάση 1.
     - `business_members`: από το 0009 μόνο `SELECT` για τον `authenticated`. Κάθε αλλαγή μέλους ή ρόλου γίνεται μόνο μέσω RPC (§8).
   - Πίνακες στο `private` (π.χ. `platform_settings`, `factor_change_grants`, `mfa_factor_snapshot`, `security_events`): κανένα GRANT στους ρόλους του API. Τους διαβάζουν και τους γράφουν μόνο definer functions και jobs.
   - `service_role`: μόνο όσα χρειάζονται οι Edge Functions.
   - Πίνακες μόνο για προσθήκη (`appointment_events`, `audit_log`): μόνο `SELECT` για τους ρόλους του API. Γράφουν μόνο οι triggers και οι definer functions: RPCs του owner (π.χ. μέλη, ταυτότητα), το `authorize_factor_change` (owner ή manager, §8), RPCs μόνο για `service_role` (πρόσκληση, `record_support_action` της Nous) και το job ανίχνευσης αλλαγών συσκευών κωδικών (1.9, actor `system`).
5. **Functions (μοτίβο wrapper):**
   - Η Postgres δίνει `EXECUTE` στο PUBLIC **global**, και οι προεπιλογές ανά schema δεν μπορούν να το αναιρέσουν. Γι' αυτό το 0001 κάνει και τα δύο:
     - `alter default privileges for role postgres revoke execute on functions from public`
     - revoke ανά schema από `anon`, `authenticated` και `service_role`
   - Οι προεπιλογές ανήκουν στον ρόλο που **δημιουργεί** τα αντικείμενα. Γι' αυτό δηλώνονται ρητά `for role postgres` (migrations, CLI, dashboard) και δεν εξαρτώνται από το ποιο login έτρεξε το migration. Το `01_security` φτιάχνει δοκιμαστικό πίνακα και functions και ελέγχει ότι κανένας ρόλος του API δεν τα βλέπει.
   - Η λογική που παρακάμπτει το RLS ζει στο `private.<name>_impl` (SECURITY DEFINER, `search_path = ''`) και κάνει η ίδια τους ελέγχους μέλους και ρόλου. Το API βλέπει μόνο λεπτά wrappers στο `public` (SECURITY **INVOKER**).
   - **Στο `public` δεν υπάρχει καμία SECURITY DEFINER function** (το ελέγχει test).
   - Οι ρόλοι του API έχουν `USAGE` στο `private` (που δεν εκτίθεται), ώστε τα wrappers και οι πολιτικές να καλούν συγκεκριμένες functions. Το `EXECUTE` δίνεται ρητά ανά function.
   - Το `anon` εκτελεί μόνο τις read-only RPCs της δημόσιας σελίδας και τα impl τους. Στη Φάση 0 αυτό σημαίνει μόνο το `public_business_profile`, που απαντά μόνο για επιχειρήσεις με `booking_enabled`.
   - Οι trigger functions (events, audit, κατάσταση) είναι SECURITY DEFINER και δεν χρειάζονται GRANT: το `EXECUTE` δεν ελέγχεται όταν τρέχει ο trigger.
   - Allow-lists στο `01_security.test.sql`: ποιες functions εκτελούν ο `anon` και ο `authenticated`, και ποια δικαιώματα πινάκων έχει ο `authenticated`.
   - Η «μνήμη»: `private.client_memory_impl`, με υπολογισμό πάνω σε όλη την επιχείρηση, ώστε owner και staff να βλέπουν την ίδια φάση.
     - Η **ίδια** η `_impl` ελέγχει μέλος και ρόλο, και για το staff επιστρέφει τα ποσά ως `null`.
     - Το wrapper μένει λεπτό, χωρίς έλεγχο. Γενικός κανόνας: κάθε έλεγχος ασφαλείας ζει εκεί όπου παρακάμπτεται το RLS (στη definer function), ποτέ μόνο στο wrapper.
   - **Ποιος ενεργεί:**
     - Οι triggers των ραντεβού διαβάζουν το `anaklo.actor_type` μέσω `private.current_actor_type()`.
     - Χωρίς δήλωση: συνδεδεμένος χρήστης → `staff`, αλλιώς **σφάλμα** (`42501`). Άγνωστη τιμή → `22023`. Ποτέ σιωπηρό `system`, γιατί το `system` διορθώνει τα πάντα.
     - Seed, jobs, tests και οι RPCs που καλούν Edge Functions και scripts δηλώνουν ρητά `system`/`client`/`import` (μέσα στο `_impl`)· οι RPCs του `authenticated` δεν δηλώνουν τίποτα (→ `staff`).
6. **Χρήματα και ρόλοι:**
   - Το staff διαβάζει απευθείας μόνο τα δικά του ραντεβού.
   - Τα ραντεβού των άλλων τα βλέπει μέσω RPC χωρίς τιμές και ονόματα πελατών, ως «κατειλημμένο».
   - Τα συγκεντρωτικά ποσά (τζίρος, LTV, έσοδα σε κίνδυνο, κόστος SMS) δίνονται μόνο από RPC που ελέγχει τον ρόλο.
7. **Κλειδιά:** χρησιμοποιούμε τα νέα `sb_publishable_…` / `sb_secret_…` από την πρώτη μέρα. Το CI αποτυγχάνει αν βρει `service_role` ή `sb_secret_` στο build του frontend.
8. **Owner και manager:** TOTP υποχρεωτικό (αρχικά μόνο για τον owner· το ADR-0009 το διευρύνει και στον manager). Οι **κρίσιμες ενέργειες** θέλουν **φρέσκο κωδικό** από την εφαρμογή κωδικών (step-up, ADR-0009 §12–13· απόφαση Μιχάλη, 2026-09-28).
   - **Κανόνας:** η συνεδρία είναι `aal2` **και** το claim `amr` του JWT έχει μέθοδο `totp` με timestamp ≥ `now()` − παράθυρο.
     - Παράθυρο 5′ (300 s), στο `private.platform_settings.fresh_totp_max_age_seconds`: default 300, `CHECK` από 0 έως 300. Η ρύθμιση μπορεί μόνο να το κάνει αυστηρότερο.
     - Το τοπικό seed, που το χρησιμοποιούν και τα e2e, βάζει 10 s. Τα e2e περιμένουν να παλιώσει ο κωδικός της συνεδρίας, ώστε το step-up να εμφανίζεται πάντα, ενώ η επανάληψη αμέσως μετά τον νέο κωδικό περνά. Όχι 0: με 0 δεν περνά καμία κρίσιμη ενέργεια, ούτε αμέσως μετά το verify.
   - **Μία υλοποίηση, σε SQL:** `private.has_fresh_totp()` και `private.require_fresh_totp()`. Η δεύτερη σηκώνει `42501` με:
     - hint `aal2_required`, όταν η συνεδρία είναι `aal1`·
     - hint `fresh_totp_required`, όταν είναι `aal2` αλλά το timestamp του `totp` είναι παλαιότερο από το παράθυρο ή λείπει (π.χ. `amr` μόνο με `otp`, δηλαδή κωδικό email).
   - Καλείται **μέσα** σε κάθε `_impl` της λίστας (γενικός κανόνας του §5), ποτέ μόνο στο wrapper ή στο UI. Μια Edge Function καλεί πρώτα RPC ως ο χρήστης (ίδιος έλεγχος SQL) και **μετά** φτιάχνει client με `service_role`.
   - Το timestamp είναι αξιόπιστο: σε κάθε επιτυχημένο MFA verify το Supabase Auth κάνει upsert στο `mfa_amr_claims.updated_at = now()` της συνεδρίας (`models/amr.go`, `AddClaimToSession`). Αυτό γίνεται το timestamp του `totp` στο επόμενο access token. Integration test την 1η μέρα του 1.7 το επιβεβαιώνει στο αποκωδικοποιημένο JWT.
   - **Κρίσιμες ενέργειες** (ο ρόλος που χρειάζεται μένει ο ίδιος):
     - ανωνυμοποίηση πελάτη: `erase_client` (1.8), μόνο owner·
     - μέλη και ρόλοι, μαζί με προσθήκη και αφαίρεση owner: `can_manage_members` (ο έλεγχος του `invite-member`), `set_member_role`, `remove_member` (1.7), μόνο owner·
     - slug, ζώνη ώρας, νόμισμα: `change_business_identity` (1.7), μόνο owner·
     - εξαγωγή πελατολογίου: κάθε RPC ή Edge Function εξαγωγής όταν έρθει (καμία στη Φάση 1), owner και manager·
     - αλλαγή ή αφαίρεση συσκευών κωδικών (παράγοντες TOTP) του ίδιου του χρήστη: `authorize_factor_change` και Edge Function `manage-factors` (1.7, ADR-0009)·
     - απενεργοποίηση επιχείρησης (τερματισμός λογαριασμού): μελλοντικό RPC `deactivate_business` (Φάση 5), μόνο owner. **Όχι** το `booking_enabled`, που είναι καθημερινή ρύθμιση.
   - **Όχι σε καθημερινές ενέργειες:** ραντεβού, μετακινήσεις, ακυρώσεις, πελάτες, σημειώσεις, συναινέσεις, ωράρια, κλεισίματα, άδειες, πολιτική κράτησης, `booking_enabled`, ρυθμίσεις. Αυτές θέλουν μόνο τη συνεδρία· owner και manager είναι ήδη `aal2` από τη σύνδεση.
   - **Συσκευές κωδικών:** το GoTrue δεν ελέγχει φρεσκάδα στα δικά του endpoints, και το hook που θα μπορούσε να αρνηθεί υπάρχει μόνο σε Teams/Enterprise. Γι' αυτό: αφαίρεση μόνο μέσω `manage-factors`, προσθήκη μόνο μετά από άδεια του `authorize_factor_change`, και job ανίχνευσης κάθε 5′ για κάθε αλλαγή που δεν ταιριάζει με άδεια: σβήνει τον μη εγκεκριμένο νέο παράγοντα, ανακαλεί τις συνεδρίες του χρήστη και ειδοποιεί χρήστη και owner (λεπτομέρειες και υπολειπόμενο ρίσκο: ADR-0009).
   - **`business_members` μόνο μέσω RPC:** στο 0009 ο `authenticated` χάνει `INSERT`, `UPDATE` και `DELETE` και κρατά μόνο `SELECT`. Έτσι ο φρέσκος κωδικός δεν παρακάμπτεται με απευθείας εγγραφή στον πίνακα.
     - Κάθε αλλαγή μέλους περνά από τα RPCs του owner και από το RPC πρόσκλησης, που είναι μόνο για `service_role`.
     - Οι restrictive πολιτικές `aal2` της Φάσης 0 μένουν ως δεύτερη γραμμή άμυνας.
     - Allow-list στο `01_security`: `business_members` μόνο `SELECT` για τον `authenticated`.
   - Αφαίρεση μέλους και αλλαγή ρόλου γίνονται μόνο με RPC του owner με φρέσκο κωδικό (`remove_member`, `set_member_role`, με `audit_log`). Στην ίδια συναλλαγή ανακαλούνται όλες οι συνεδρίες του χρήστη. Όταν ο υψηλότερος ρόλος του χρήστη πέφτει από owner/manager σε staff ή σε κανέναν, είτε με `set_member_role` είτε με `remove_member`, το ίδιο `_impl` σβήνει και όλους τους παράγοντες TOTP του και γράφει γραμμή άδειας στο `private.factor_change_grants`, ώστε η ανίχνευση να μην τη σημάνει (ADR-0009).
   - Ο ρόλος διαβάζεται πάντα από το `business_members`, ποτέ από το JWT. Αν διαγραφεί μια γραμμή από το `business_members`, η πρόσβαση κόβεται στο επόμενο αίτημα.

## Συνέπειες
- Το test «το `anon` δεν έχει κανένα δικαίωμα σε κανέναν πίνακα του `public`» τρέχει σε κάθε PR.
- Φρέσκος κωδικός (§8), pgTAP στα `14_members_identity`, `15_client_ops` και `01_security`, για κάθε `_impl` της λίστας:
  - `aal1` → `42501` με `aal2_required`·
  - `aal2` με `totp` πριν από 6′ → `fresh_totp_required`·
  - `aal2` με `amr` μόνο `otp` → `fresh_totp_required`·
  - `aal2` με `totp` πριν από 1′ → επιτυχία·
  - παράθυρο 0 → πάντα `fresh_totp_required`·
  - το `CHECK` του `platform_settings` απορρίπτει τιμή > 300·
  - ο `authenticated` δεν έχει `INSERT`/`UPDATE`/`DELETE` στο `business_members`.
- Owner και manager θα βλέπουν σχεδόν πάντα το `StepUpSheet` σε κρίσιμη ενέργεια, γιατί η σύνδεση σπάνια είναι μέσα στο παράθυρο των 5′. Αποδεκτό: οι ενέργειες αυτές είναι σπάνιες, και οι καθημερινές δεν ζητούν τίποτα.
- Οι αλλαγές συσκευών κωδικών απευθείας στο GoTrue, με κλεμμένη συνεδρία `aal2`, δεν μπλοκάρονται στο Supabase Pro, μόνο ανιχνεύονται. Ένας νέος παράγοντας σβήνεται· μια αφαίρεση δεν αναιρείται (το μυστικό χάθηκε), μόνο ανακαλούνται οι συνεδρίες και φεύγει ειδοποίηση. Υπολειπόμενο ρίσκο: έως 5′ με παράγοντα που πρόσθεσε ο επιτιθέμενος (ADR-0009).
- Η σελίδα κράτησης δεν χρειάζεται supabase-js: καλεί το `/api` (same-origin proxy) με `fetch`.
