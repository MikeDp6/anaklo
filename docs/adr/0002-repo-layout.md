# ADR-0002: Δομή repo και κοινός κώδικας

- Κατάσταση: αποδεκτό
- Ημερομηνία: 2026-09-27

## Πλαίσιο
Το SPEC v0.3 έδειχνε monorepo (`apps/web/src`), ενώ το CLAUDE.md έδειχνε `src/` στη ρίζα. Κανένα από τα δύο δεν έλεγε πώς θα μοιράζονται Zod schemas ανάμεσα στο Vite και στις Edge Functions (Deno).

Υπάρχουν και δύο ανάγκες από την απόδοση και την ασφάλεια:
- Η σελίδα κράτησης πρέπει να μείνει μικρή (≤120KB gzip).
- Η σελίδα κράτησης δεν πρέπει να εγκαθιστά τον service worker της εφαρμογής επαγγελματία.

## Απόφαση
1. **Ένα package**, χωρίς workspaces, με `src/` στη ρίζα (όπως στο CLAUDE.md). Το `packages/verticals/` είναι απλός φάκελος με JSON.
2. **Δύο HTML entries** στο ίδιο Vite build:
   - `index.html` → σελίδα κράτησης (`/`, `/:slug`), κώδικας στο `src/app/booking/`.
     - **Χωρίς router:** το `route.ts` βγάζει μία από τρεις καταστάσεις (landing, επιχείρηση, δεν βρέθηκε), και τα βήματα κράτησης ζουν στο state.
   - `app/index.html` → εφαρμογή επαγγελματία (`/app/*`), κώδικας στο `src/app/pro/`.
     - React Router data mode.
     - Δικό της manifest και service worker (scope `/app/`).

   Ο κοινός κώδικας ζει στο `src/shared/` και στο `src/features/`.
3. **Κώδικας κοινός με τις Edge Functions:** ζει στο `supabase/functions/_shared/`. Περιέχει από τη Φάση 0:
   - `money.ts`, `dates.ts`, `phone.ts`
   - `sms.ts`, `sms-templates.ts`
   - `domain.ts` (λίστες τιμών των CHECK)
   - τα αντίστοιχα Vitest tests

   Το Vite τον φορτώνει με alias (`@fn-shared`) και το `src/shared/lib/*` απλώς τον επανεξάγει. Κανόνες για αυτόν τον κώδικα:
   - όχι DOM, Node ή Deno APIs (εξαίρεση τα tests)
   - σχετικά imports με κατάληξη `.ts`
   - γυμνά imports (`zod/mini`, `date-fns`, `date-fns/locale`, `@date-fns/tz`) μόνο αν αντιστοιχίζονται στο `supabase/functions/deno.json` στην **ίδια** έκδοση με το `package.json`
4. Όταν υπάρξουν Edge Functions (Φάση 1), το CI τρέχει και `deno check`.

## Συνέπειες
- Το Vite dev server χρειάζεται ένα μικρό plugin, ώστε οι διαδρομές `/app/*` να σερβίρουν το `app/index.html`.
- Στην παραγωγή το hosting κάνει rewrite:
  - `/app/*` → `app/index.html`
  - `/<slug>` → σελίδα κράτησης (αργότερα μέσω server handler)
- Ο έλεγχος μεγέθους μετρά μόνο το entry της σελίδας κράτησης.
