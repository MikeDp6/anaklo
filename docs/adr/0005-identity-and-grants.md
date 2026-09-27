# ADR-0005: Ταυτότητα, RLS και δικαιώματα

- Κατάσταση: αποδεκτό
- Ημερομηνία: 2026-09-27

## Πλαίσιο
Από 30/5/2026 τα νέα Supabase projects δεν εκθέτουν πίνακες στο Data API χωρίς ρητό `GRANT`. Όταν εμφανιστεί το πρώτο «permission denied», η εύκολη αντίδραση είναι το `grant all … to anon`, που εκθέτει τα πάντα.

Επιπλέον, τα FK δεν ελέγχονται από το RLS, και το `service_role` το παρακάμπτει εντελώς.

## Απόφαση
1. **`auth.users` = μόνο προσωπικό και ιδιοκτήτες.**
   - Οι πελάτες **δεν** είναι χρήστες Auth. Είναι γραμμές στο `clients` της κάθε επιχείρησης.
   - Επαληθεύονται με OTP ή έμπιστη συσκευή, ανά επιχείρηση (ADR-0006).
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
   - `service_role`: μόνο όσα χρειάζονται οι Edge Functions.
   - Πίνακες μόνο για προσθήκη (`appointment_events`, `audit_log`): μόνο `SELECT` για τους ρόλους του API. Γράφουν μόνο οι triggers ή οι functions του owner.
5. **Functions (μοτίβο wrapper):**
   - Η Postgres δίνει `EXECUTE` στο PUBLIC **global**, και οι προεπιλογές ανά schema δεν μπορούν να το αναιρέσουν. Γι' αυτό το 0001 κάνει και τα δύο:
     - `alter default privileges revoke execute on functions from public`
     - revoke ανά schema από `anon`, `authenticated` και `service_role`
   - Η λογική που παρακάμπτει το RLS ζει στο `private.<name>_impl` (SECURITY DEFINER, `search_path = ''`) και κάνει η ίδια τους ελέγχους μέλους και ρόλου. Το API βλέπει μόνο λεπτά wrappers στο `public` (SECURITY **INVOKER**).
   - **Στο `public` δεν υπάρχει καμία SECURITY DEFINER function** (το ελέγχει test).
   - Οι ρόλοι του API έχουν `USAGE` στο `private` (που δεν εκτίθεται), ώστε τα wrappers και οι πολιτικές να καλούν συγκεκριμένες functions. Το `EXECUTE` δίνεται ρητά ανά function.
   - Το `anon` εκτελεί μόνο τις read-only RPCs της δημόσιας σελίδας και τα impl τους. Στη Φάση 0 αυτό σημαίνει μόνο το `public_business_profile`, που απαντά μόνο για επιχειρήσεις με `booking_enabled`.
   - Οι trigger functions (events, audit, κατάσταση) είναι SECURITY DEFINER και δεν χρειάζονται GRANT: το `EXECUTE` δεν ελέγχεται όταν τρέχει ο trigger.
   - Allow-lists στο `01_security.test.sql`: ποιες functions εκτελούν ο `anon` και ο `authenticated`, και ποια δικαιώματα πινάκων έχει ο `authenticated`.
   - Η «μνήμη»: `private.client_memory_impl` με δικό της έλεγχο μέλους, υπολογισμός πάνω σε όλη την επιχείρηση. Το wrapper κρύβει τα ποσά από το staff, ώστε owner και staff να βλέπουν την ίδια φάση.
6. **Χρήματα και ρόλοι:**
   - Το staff διαβάζει απευθείας μόνο τα δικά του ραντεβού.
   - Τα ραντεβού των άλλων τα βλέπει μέσω RPC χωρίς τιμές και ονόματα πελατών, ως «κατειλημμένο».
   - Τα συγκεντρωτικά ποσά (τζίρος, LTV, έσοδα σε κίνδυνο, κόστος SMS) δίνονται μόνο από RPC που ελέγχει τον ρόλο.
7. **Κλειδιά:** χρησιμοποιούμε τα νέα `sb_publishable_…` / `sb_secret_…` από την πρώτη μέρα. Το CI αποτυγχάνει αν βρει `service_role` ή `sb_secret_` στο build του frontend.
8. **Owner:** MFA (TOTP) για εξαγωγή, διαγραφή και διαχείριση μελών. Αν διαγραφεί μια γραμμή από το `business_members`, η πρόσβαση κόβεται στο επόμενο αίτημα.

## Συνέπειες
- Το test «το `anon` δεν έχει κανένα δικαίωμα σε κανέναν πίνακα του `public`» τρέχει σε κάθε PR.
- Η σελίδα κράτησης δεν χρειάζεται supabase-js: καλεί το `/api` (same-origin proxy) με `fetch`.
