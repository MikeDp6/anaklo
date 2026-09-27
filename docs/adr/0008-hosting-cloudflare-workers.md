# ADR-0008: Hosting σε Cloudflare Workers

- Κατάσταση: αποδεκτό
- Ημερομηνία: 2026-09-27

## Πλαίσιο

Το SPEC v0.4 άφηνε ανοιχτό το hosting (§18 ερ. 2: Vercel Pro ή Cloudflare Pages). Από την πρώτη μέρα η Φάση 1 χρειάζεται:

- δύο εισόδους HTML από το ίδιο build (ADR-0002): τη σελίδα κράτησης (`/`, `/<slug>`) και την εφαρμογή επαγγελματία (`/app/*`)
- same-origin proxy `/api` προς το Supabase, ώστε το cookie της έμπιστης συσκευής να είναι first-party (ADR-0006)
- την πραγματική IP του πελάτη, για τα όρια του OTP
- HTML ανά επιχείρηση στο `/<slug>` (τίτλος, Open Graph, θέμα), γιατί οι προεπισκοπήσεις link σε Instagram, WhatsApp και Viber δεν τρέχουν JavaScript
- εμπορική χρήση με μικρό κόστος

| Επιλογή | Κόστος | Πρόβλημα |
|---|---|---|
| Vercel Hobby | δωρεάν | Απαγορεύει την εμπορική χρήση. |
| Vercel Pro | $20/μήνα | Κόστος πριν από τον πρώτο πελάτη. Θέλει πάλι function για την έγχυση HTML και το cookie. |
| Cloudflare Pages + Functions | δωρεάν | Δουλεύει, αλλά η δρομολόγηση μοιράζεται σε `_routes.json`, `_redirects` και αρχεία functions. Η Cloudflare προτείνει πλέον Workers για νέα projects. |
| Cloudflare Workers + static assets | δωρεάν ή $5/μήνα | Κανένα για τη Φάση 1. |

Σήμερα το `/api` υπάρχει μόνο ως proxy του Vite (`^/api/`) στο dev. Το `build.sourcemap = 'hidden'` δεν αφήνει links προς τα maps, αλλά τα αρχεία `.map` μένουν στο `dist`. Ένα deploy του `dist` όπως είναι θα τα σέρβιρε.

## Απόφαση

1. **Cloudflare Workers με static assets και έναν Worker.**
   - Ο κώδικας του Worker ζει στον φάκελο `edge/`. Η λογική του (κανόνες proxy, cookie, έγχυση HTML) γράφεται σε καθαρά modules με Vitest. Το αρχείο εισόδου του Worker μόνο τα συνδέει.
   - Ένας Worker με όλη τη δρομολόγηση και το proxy σε ένα σημείο. Γι' αυτό όχι Pages.
   - `wrangler` ως devDependency με ακριβή έκδοση (ADR-0001), μόνο μέσα από npm scripts.
   - Τα μυστικά του Worker (π.χ. `PROXY_SECRET`) μπαίνουν με `wrangler secret put`, από το `npm run secrets:dev` (1.1), με την ίδια τιμή που παίρνουν οι Edge Functions. Ποτέ στο repo, ποτέ σε μεταβλητή `VITE_*`.
2. **Δρομολόγηση:**

   | Διαδρομή | Τι σερβίρεται |
   |---|---|
   | στατικά αρχεία (`/assets/*`, εικονίδια, manifest, `/app/sw.js`) | Κατευθείαν από τα static assets, χωρίς να τρέξει ο Worker |
   | `/` | Η είσοδος της σελίδας κράτησης (`index.html`) |
   | `/app` και `/app/*` χωρίς κατάληξη αρχείου | Το κέλυφος της εφαρμογής επαγγελματία (`app/index.html`), με τον ίδιο κανόνα όπως το `proAppShell` του Vite |
   | `/api/*` | Το proxy (σημείο 3) |
   | `/<slug>` | Η σελίδα κράτησης με έγχυση (σημείο 5) |
   | οτιδήποτε άλλο | Το κέλυφος της σελίδας κράτησης με status **404** |

   - Ρυθμίσεις των static assets στο `wrangler`: `assets.html_handling = "none"` και `not_found_handling = "none"` (η προεπιλογή). Με το προεπιλεγμένο `auto-trailing-slash`, το `env.ASSETS.fetch('/index.html')` ή `('/app/index.html')` δίνει 307 αντί για το κέλυφος. Με `single-page-application`, οι διαδρομές χωρίς asset σερβίρονται χωρίς να τρέξει ο Worker, άρα χωρίς `/<slug>` και `/api`. Smoke test: το `/demo-barber` δίνει 200 HTML, όχι 307.
   - Νέες διαδρομές της σελίδας κράτησης (π.χ. το link διαχείρισης και το `/r/<code>` του 1.3, σημείο 5) δηλώνονται ρητά και στον Worker και στο `route.ts`.
   - Τα δεσμευμένα slugs (`app`, `api`, `assets` κ.λπ.) τα αποκλείει ήδη η βάση. Ένα slug δεν συγκρούεται ποτέ με διαδρομή του Worker.
   - Σελίδες με token στη διαδρομή (link διαχείρισης) στέλνουν `Referrer-Policy: no-referrer` και `Cache-Control: no-store`.

3. **Σκληρυμένο `/api` proxy**, μόνο για τη σελίδα κράτησης:
   - Αγκυρωμένο στο `/api/`, με τον ίδιο κανόνα όπως στο Vite: το `/api-barber` είναι slug, όχι proxy.
   - **Μόνο διαδρομές από allow-list:** συγκεκριμένα RPCs (`/api/rest/v1/rpc/<name>`) και Edge Functions (`/api/functions/v1/<name>`), με τις μεθόδους που χρειάζεται η καθεμία. Οτιδήποτε άλλο (πίνακες του PostgREST, Auth, Storage) παίρνει 404 χωρίς να φτάσει στο Supabase.
   - **Αφαιρεί** από το αίτημα τα `x-anaklo-*`, `x-forwarded-*` και `x-real-ip` που έστειλε ο client, και το `Cookie`. Πριν από την αφαίρεση διαβάζει μόνο το `x-anaklo-business` (σημείο 4).
   - **Προσθέτει:**
     - το μυστικό header του proxy (`x-anaklo-proxy-secret`)
     - το publishable key ως `apikey` (αντικαθιστά ό,τι έστειλε ο client· το `publicApi.ts` μπορεί να σταματήσει να το στέλνει)
     - το `x-anaklo-client-ip`, από το `CF-Connecting-IP`
     - το `x-region` της περιοχής της βάσης, ώστε οι Edge Functions να τρέχουν κοντά της
     - το cookie της έμπιστης συσκευής και την επιχείρησή του, όπου υπάρχουν (σημείο 4)
   - Κάθε απάντηση έχει `Cache-Control: no-store`.
   - Οι Edge Functions που καλεί η σελίδα κράτησης μέσω `/api` (`health`, `spike-td`, `public-booking`, `manage`) ελέγχουν το μυστικό με σύγκριση σταθερού χρόνου (`requireProxy(req, secret)` στο `_shared/http.ts`, που μένει καθαρό χωρίς `Deno`· το `index.ts` κάθε function διαβάζει το `PROXY_SECRET` από το `Deno.env` και το περνά ως όρισμα, ADR-0002 §3) και διαβάζουν την IP **μόνο** από το `x-anaklo-client-ip`. Χωρίς σωστό μυστικό: 403. Αν το `PROXY_SECRET` λείπει ή είναι κενό στο περιβάλλον της function: 500, και το αίτημα δεν γίνεται ποτέ δεκτό. Έτσι κλείνει η αλυσίδα εμπιστοσύνης του ADR-0006 §6.
   - Οι υπόλοιπες functions δεν περνούν από το `/api` και έχουν δικό τους έλεγχο: `invite-member` και `spike-push` το JWT του χρήστη (ADR-0009, ADR-0010), `dispatch` μυστικό header από το Vault, `sms-dlr` υπογραφή ή μυστικό του παρόχου.
4. **Ο Worker κατέχει το cookie της έμπιστης συσκευής** `__Host-td_<business_id>`. Οι Edge Functions δεν διαβάζουν και δεν γράφουν ποτέ cookies.
   - **Αίτημα:** η σελίδα κράτησης δηλώνει την επιχείρηση στο header `x-anaklo-business` (uuid). Είναι το μόνο `x-anaklo-*` του client που διαβάζεται:
     - Ο Worker το διαβάζει **πριν** αφαιρέσει τα `x-anaklo-*` του client και ελέγχει ότι είναι uuid. Αλλιώς δεν προωθεί κανένα cookie.
     - Προωθεί **μόνο** το cookie `__Host-td_<εκείνο το id>`, ως header `x-anaklo-td`, και ξαναβάζει το ίδιο id στο `x-anaklo-business`. Καμία κλήση δεν βλέπει τα cookies άλλων επιχειρήσεων (ADR-0006 §2).
     - Η Edge Function δέχεται το token μόνο αν το `business_id` του σώματος είναι το ίδιο με το `x-anaklo-business`.
   - **Απάντηση:** το header `x-anaklo-set-td` της Edge Function γίνεται `Set-Cookie: __Host-td_<business_id>=<token>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=15552000` και αφαιρείται από την απάντηση. Κενή τιμή σημαίνει διαγραφή (`Max-Age=0`).
   - Το όνομα και τα attributes του cookie ορίζονται σε **ένα** module. Vitest για τη μετατροπή cookie ⇄ header, για ψεύτικα `x-anaklo-*` από τον client (το `x-anaklo-business` επιλέγει cookie, τα υπόλοιπα σβήνονται), για `x-anaklo-business` που δεν είναι uuid, και για όνομα και attributes ανά `APP_ENV`.
   - Μόνο τοπικά (`APP_ENV=local`, `http://localhost`) το cookie γράφεται ως `td_<business_id>` **χωρίς** `Secure`: το `__Host-` απαιτεί `Secure`, και το WebKit του Playwright δεν κρατά `Secure` cookie σε http. Για κάθε άλλη τιμή του `APP_ENV`, ή αν λείπει, ισχύουν `__Host-` και `Secure`.
   - Το ADR-0006 δεν αλλάζει: το cookie είναι first-party, από το domain της σελίδας. Αλλάζει μόνο ποιο κομμάτι γράφει το `Set-Cookie`.
5. **`/<slug>` με έγχυση HTML:**
   - Ο Worker παίρνει τα δεδομένα της επιχείρησης από read-only RPC του `anon`: στο 1.1 το `public_business_profile` (Φάση 0), από το 1.3 το `public_booking_catalogue(p_slug)` (1.2), που φέρνει και τον κατάλογο. Γράφει στο κέλυφος τίτλο, περιγραφή, Open Graph, θέμα και τα αρχικά δεδομένα (από το 1.3 τον κατάλογο).
   - Η έγχυση είναι **καθαρή συνάρτηση πάνω σε string**, κοινή για τον Worker και για middleware του Vite dev server. Όχι `HTMLRewriter`: υπάρχει μόνο στο workerd, οπότε ούτε το Vitest ούτε το Playwright θα έλεγχαν τη διαδρομή της παραγωγής.
   - Vitest για το escaping, ώστε ένα όνομα επιχείρησης με `</script>` να μην κλείνει το tag:
     - τιμές σε attributes και κείμενο: `&`, `<`, `>`, `"` → HTML entities
     - δεδομένα JSON μέσα σε `<script>`: `<` → `\u003c`
   - Τα κείμενα του Open Graph έρχονται από τους καταλόγους i18n της σελίδας κράτησης, στη γλώσσα της επιχείρησης. Καμία καρφωτή φράση στον Worker.
   - Άγνωστο slug, ή επιχείρηση χωρίς `booking_enabled`: το κέλυφος της σελίδας κράτησης με status **404**. Από το 1.7, slug που υπάρχει στο `business_slug_aliases` → 301 στο τρέχον slug. Από το 1.3, `/r/<code>` → 302 στο `/<slug>` μέσω του `public_slug_for_code`. Το μήνυμα το δείχνει η σελίδα, από το i18n.
   - Αν το Supabase δεν απαντήσει, ο Worker σερβίρει το κέλυφος χωρίς έγχυση. Η σελίδα φορτώνει τότε τα δεδομένα με `fetch`, όπως σήμερα.
6. **Τοπικά όπως στην παραγωγή:**
   - Ο Vite dev server χρησιμοποιεί τα ίδια modules (proxy, cookie, έγχυση) ως middleware, στη θέση του σημερινού `server.proxy`.
   - Το μυστικό του proxy έρχεται από μεταβλητή του `.env.local` **χωρίς** πρόθεμα `VITE_`. Το τοπικό edge runtime δεν διαβάζει το `.env.local`: παίρνει την ίδια τιμή από το `[edge_runtime.secrets]` του `config.toml` (`env(PROXY_SECRET)`). Στο CI η τιμή μπαίνει ως env του job (εργασία του 1.1).
   - Τα e2e τρέχουν πάνω σε αυτή τη διαδρομή.
7. **Source maps:**
   - Το `build.sourcemap = 'hidden'` και ο έλεγχος του `postbuild` μένουν.
   - Πριν από **κάθε** deploy, από το 1.1, τα `.map` σβήνονται από το `dist`. Το script αποτυγχάνει αν μείνει κάποιο.
   - Δεύτερη ασφάλεια: `public/.assetsignore` με `*.map`. Το `.assetsignore` μετρά μόνο μέσα στον φάκελο των assets, και το Vite αδειάζει το `dist/` σε κάθε build· από το `public/` το αντιγράφει στο `dist/`.
   - Από το 1.9 ανεβαίνουν πρώτα στο Sentry και μετά σβήνονται.
8. **Domains:**
   - `anaklo.gr` για prod, `dev.anaklo.gr` για dev. DNS στο Cloudflare από την πρώτη μέρα.
   - Email (Resend) από sending subdomain (π.χ. `mail.anaklo.gr`), στην περιοχή EU, με SPF, DKIM και DMARC.
   - Όχι `*.workers.dev`: στα SMS το link έχει όριο 40 χαρακτήρων και το domain 20 (ADR-0007). Το `dev.anaklo.gr/m/<token 22 χαρακτήρων>` βγαίνει 38.
9. **Deploy:** `npm run deploy:dev` (`scripts/deploy-dev.mjs`).
   - Ελέγχει πρώτα ότι το συνδεδεμένο project του Supabase είναι το `SUPABASE_DEV_PROJECT_REF`, όπως το `db:reset:dev`.
   - Σειρά του ADR-0004: migration → Edge Functions → Worker.
   - Σβήνει τα `.map` πριν το `wrangler deploy`.
   - Είναι idempotent: ένα δεύτερο τρέξιμο δεν αλλάζει τίποτα.
   - Δεν αγγίζει ποτέ τις ρυθμίσεις του Auth (ADR-0009).
   - Το αντίστοιχο script για το prod έρχεται στη Φάση 3.
10. **Η εφαρμογή επαγγελματία μιλά απευθείας στο Supabase** (`https://<ref>.supabase.co`) για Auth, PostgREST, Storage και τις Edge Functions που καλούνται με JWT χρήστη (π.χ. `invite-member`) (SPEC §6). Δεν περνά από το `/api`. Έτσι το allow-list μένει μικρό, και το Realtime της Φάσης 3 δεν χρειάζεται WebSocket μέσα από το proxy.

## Συνέπειες

- Κλείνει το §18 ερ. 2. Τα §6 και §18 του SPEC έχουν ήδη ενημερωθεί.
- Κόστος: δωρεάν πλάνο στη Φάση 1. Το όριο CPU του (10 ms ανά αίτημα) αρκεί, γιατί ο Worker κάνει μόνο fetch και μετασχηματισμό string. Αν δεν αρκέσει, πλάνο $5/μήνα.
- Η Cloudflare γίνεται υποεκτελών: βλέπει IP και cookies κατά τη μεταφορά. Μπαίνει στο `docs/subprocessors.md` με τη σύμβαση επεξεργασίας της και τον μηχανισμό διαβίβασης.
- Νέες ρυθμίσεις: `PROXY_SECRET` (Worker, Edge Functions, `.env.local`) και η διεύθυνση του Supabase για τον Worker. Το `.env.example` ενημερώνεται στο 1.1.
- Η σύνδεση του Worker με τα modules ελέγχεται με smoke test στο `dev.anaklo.gr`: το `/api/functions/v1/health` δίνει 200 μέσω του proxy και 403 όταν καλείται απευθείας.
- Αν πέσει η Cloudflare, πέφτουν και οι δύο εφαρμογές. Το βλέπει το uptime monitor (1.9).
