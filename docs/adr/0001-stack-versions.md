# ADR-0001: Stack και εκδόσεις

- Κατάσταση: αποδεκτό
- Ημερομηνία: 2026-09-27

## Πλαίσιο
Το SPEC v0.3 ονόμαζε βιβλιοθήκες χωρίς εκδόσεις, και κάποιες είχαν παλιώσει: π.χ. το `date-fns-tz` έχει αντικατασταθεί από το `@date-fns/tz`, και το React Router έχει πλέον τρεις «λειτουργίες». Αν οι εκδόσεις δεν είναι καρφωμένες, ένας agent μπορεί να στήσει λάθος μοτίβα, π.χ. SSR του framework mode.

## Απόφαση
Εκδόσεις καρφωμένες ακριβώς στο `package.json` (`save-exact`). Οι αναβαθμίσεις γίνονται συνειδητά, με δικό τους PR.

| Περιοχή | Επιλογή | Σημείωση |
|---|---|---|
| UI | React 19.3 | |
| Routing | React Router 8, **data mode** (`createBrowserRouter`, lazy routes), **μόνο στην εφαρμογή επαγγελματία** | Όχι framework mode / SSR. Η σελίδα κράτησης δεν έχει router (`route.ts`), για να γλιτώσει ~30 KB. |
| Server state | TanStack Query 5 | |
| Φόρμες | React Hook Form 7 + `@hookform/resolvers` 5 | Όχι στη σελίδα κράτησης (μέγεθος) |
| Validation | Zod 4, **μόνο `zod/mini`**, παντού (web και Edge Functions) | Αποφασίστηκε με μέτρηση: με το classic η σελίδα κράτησης ήταν 145.7 KB. Με mini και χωρίς router έπεσε στα 100.7 KB. Το ESLint απαγορεύει το `import 'zod'`. |
| Ημερομηνίες | date-fns 4 + `@date-fns/tz` | Μόνο μέσα από το `dates.ts` |
| i18n | i18next 26 + react-i18next 17 | Μόνο τα ελληνικά φορτώνουν αρχικά |
| Build | Vite 8 + `@vitejs/plugin-react` 6 | Δύο HTML entries (ADR-0002) |
| Γλώσσα | **TypeScript 6.0.3** | Όχι 7: το typescript-eslint 8 υποστηρίζει έως <6.1 |
| Runtime | Node **≥ 24.15** (`.nvmrc` 24, `engines`) | Το jsdom 30 των tests το απαιτεί. Το CI παίρνει την έκδοση από το `.nvmrc`. |
| Tests | Vitest 5 (UTC μέσω `vitest.config.ts`), Playwright 1.63, pgTAP μέσω Supabase CLI | |
| Lint | ESLint 10 + typescript-eslint 8, Prettier 3 | |
| Backend CLI | `supabase` (npm, devDependency) | Μέσα από npm scripts |
| Τηλέφωνα | **Δικό μας `phone.ts`** (ελληνικά πρώτα, E.164 για τα υπόλοιπα) | Όχι libphonenumber-js: ~45KB gzip για τη σελίδα κράτησης. Η τελική επικύρωση γίνεται στον server. |

Δεν χρησιμοποιούμε Tailwind, UI kits ή βιβλιοθήκη ημερολογίου στο MVP.

## Συνέπειες
- Το CI τρέχει `npm ci`, που αποτυγχάνει όταν `package.json` και `package-lock.json` διαφωνούν.
- Όταν το typescript-eslint υποστηρίξει το TS 7, η αναβάθμιση γίνεται με ξεχωριστό ADR.
