# Anaklo — Κίνηση, μεταβάσεις & γραφικά (Κατεύθυνση Δ «Ζεστή πολυτέλεια»)

> Προδιαγραφή για υλοποίηση. Προέκυψε από ανάλυση του Framer template «LuxySpa» (luxury-spa.framer.website) στον browser, Σεπτ. 2026.
> **Παίρνουμε τεχνικές και αίσθηση — ΟΧΙ assets ή κώδικα.** Οι φωτογραφίες, τα εικονίδια και ο κώδικας του template ανήκουν στον δημιουργό του (πληρωμένο template). Όλα τα παρακάτω είναι δική μας υλοποίηση με CSS και μικρά React hooks.
> Οι χρόνοι σημειώνονται **(μετρημένο)** όπου μετρήθηκαν στη ζωντανή σελίδα, αλλιώς είναι δική μας τιμή με ίδια αίσθηση.

---

## 0. Κανόνες (ισχύουν παντού)

1. **Μόνο `transform` και `opacity`** στις κινήσεις. Ποτέ `width/height/top/left` (jank σε φτηνά Android).
2. **`prefers-reduced-motion: reduce` → καμία κίνηση**, το περιεχόμενο εμφανίζεται αμέσως στην τελική του θέση. Υποχρεωτικό, με test.
3. **Χωρίς βιβλιοθήκη κίνησης** (όχι framer-motion/GSAP): η σελίδα κράτησης έχει όριο 120 KB JS. Μόνο CSS + τα 4 μικρά hooks του §5.
4. **Hover μόνο σε συσκευές με ποντίκι** (`@media (hover: hover) and (pointer: fine)`). Σε αφή: «πάτημα» (scale .97).
5. **Η κίνηση δεν καθυστερεί ποτέ την ενέργεια.** Ο χρήστης μπορεί να πατήσει κουμπί ενώ ακόμα «ανεβαίνει».
6. **Πού επιτρέπεται τι:**

| Επιφάνεια | Επίπεδο κίνησης |
|---|---|
| **Site μάρκετινγκ anaklo.gr** | Πλήρες: όλα τα εφέ του §3 |
| **Σελίδα κράτησης επιχείρησης** | Μεσαίο: E1–E6, E8, E9, E14–E16. **Χωρίς** splash (E11) και scroll-linked (E7) — βαραίνουν το LCP |
| **Εφαρμογή επαγγελματία (PWA)** | Ελάχιστο: E2, E6 (μόνο «Σήμερα»), E14–E17. Ανοίγει 50 φορές/μέρα — η κίνηση πρέπει να «εξαφανίζεται» |

---

## 1. Tokens

```css
:root {
  /* Χρώματα — Κατεύθυνση Δ (από τη ζωντανή σελίδα, προσαρμοσμένα για αντίθεση WCAG AA) */
  --lux-espresso: #503011;   /* κύριο σκούρο: hero, κύρια κουμπιά */
  --lux-espresso-deep: #422100; /* γέμισμα hover κουμπιών (μετρημένο) */
  --lux-night: #1C1004;      /* πολύ σκούρο: overlays */
  --lux-sand: #D9CBBC;       /* φόντο ενοτήτων μάρκετινγκ */
  --lux-sand-app: #F3EBE1;   /* φόντο εφαρμογής (ανοιχτότερο, κουράζει λιγότερο) */
  --lux-cream: #FFF9F2;      /* κάρτες / επιφάνειες */
  --lux-line: #DCCDBB;       /* περιγράμματα */
  --lux-bronze: #8B5524;     /* τίτλοι & ετικέτες σε ανοιχτό φόντο (μόνο ≥ 14px bold ή μεγάλοι τίτλοι) */
  --lux-gold: #D4BE6E;       /* ετικέτες ΜΟΝΟ σε σκούρο φόντο */
  --lux-ink: #2B2119;        /* κείμενο */
  --lux-muted: #6E5F50;      /* δευτερεύον κείμενο */

  /* Τυπογραφία */
  --font-display: 'GFS Didot', 'Noto Serif Display', Georgia, serif; /* αντί για Playfair (δεν έχει ελληνικά) */
  --font-body: 'Manrope', system-ui, sans-serif;                    /* αντί για Lato (δεν έχει ελληνικά στο GF) */
  --eyebrow-tracking: 0.32em;   /* ετικέτες «R E S T  Y O U R  B O D Y» */
  --display-tracking: -0.02em;  /* μεγάλοι τίτλοι: σφιχτό */

  /* Σχήματα */
  --radius-pill: 999px;
  --radius-card: 22px;
  --frame-offset: 10px;         /* E8 μετατοπισμένο περίγραμμα */

  /* Χρόνοι */
  --dur-press: 150ms;
  --dur-fast: 250ms;
  --dur-base: 450ms;
  --dur-slow: 700ms;
  --dur-fill: 600ms;            /* E1 (μετρημένο ~600ms) */
  --stagger: 40ms;              /* ανά λέξη στο E5 */

  /* Easing */
  --ease-out: cubic-bezier(.2, .8, .2, 1);     /* εμφανίσεις */
  --ease-in-out: cubic-bezier(.65, 0, .35, 1); /* γεμίσματα / ρολά */
}
```

**Γραμματοσειρές:** self-hosted woff2 (όχι Google Fonts CDN — GDPR). Μόνο υποσύνολα `greek` + `latin`. `font-display: swap`.

---

## 2. Γραφικά μοτίβα (στατικά)

| Κωδ. | Μοτίβο | Περιγραφή | Πού στο Anaklo |
|---|---|---|---|
| G1 | **Ετικέτα με αραιό διάστιχο** | Κεφαλαία, 11–14px, bold, `letter-spacing: var(--eyebrow-tracking)`, χρυσό σε σκούρο / μπρονζέ σε ανοιχτό | Πάνω από τίτλους ενοτήτων, «ΕΠΟΜΕΝΟ · ΣΕ 25′» |
| G2 | **Μεγάλος Didot τίτλος** | 32–56px app / έως 96px site, weight 400, σφιχτό tracking, line-height 1.05 | Χαιρετισμός, όνομα επιχείρησης, hero site |
| G3 | **Pill κουμπιά** | Δύο παραλλαγές: γεμάτο (κρεμ ή espresso) και «γυάλινο» (λευκό 20% + χρυσό περίγραμμα 1px) πάνω σε σκούρο | Όλα τα CTA |
| G4 | **Κάψουλα εικόνας** | `border-radius: 999px` σε κάθετη φωτογραφία (π.χ. 120×220) | Gallery δουλειάς, φωτό προσωπικού |
| G5 | **Μετατοπισμένο περίγραμμα** | Λεπτό 1px περίγραμμα (μπρονζέ) ίδιου σχήματος, μετατοπισμένο +10px δεξιά/κάτω πίσω από κάρτα ή φωτογραφία | Κάρτα «Επόμενο», εξώφυλλο επιχείρησης, κάρτες υπηρεσιών στο site |
| G6 | **Σκούρο hero με ζεστή φωτογραφία** | Φωτογραφία με overlay `linear-gradient(to top, rgba(28,16,4,.75), transparent 60%)` για αναγνωσιμότητα | Εξώφυλλο σελίδας κράτησης (όταν η επιχείρηση επιλέξει «σκούρο») |
| G7 | **Διακοσμητικό περίγραμμα φύλλου** | Λεπτό line-art σε χαμηλή αδιαφάνεια στη γωνία ενότητας | Μόνο site μάρκετινγκ — **δικό μας SVG**, όχι του template |

---

## 3. Κατάλογος κινήσεων

### E1 — «Υγρό γέμισμα» κουμπιού (hover)
- **Τι:** ένας κύκλος (~180% του πλάτους) κρυμμένος κάτω από το κουμπί ανεβαίνει και το γεμίζει με σκούρο· ταυτόχρονα η ετικέτα αλλάζει χρώμα (κρεμ). Στο mouse-out κατεβαίνει.
- **Χρόνος:** ~600ms **(μετρημένο)**, `--ease-in-out`.
- **Πού:** κύρια CTA site & σελίδας κράτησης (μόνο με ποντίκι).
- **Υλοποίηση:** §4 `.btn-fill`.

### E2 — «Ρολό» κειμένου (hover)
- **Τι:** το κείμενο υπάρχει δύο φορές στοιβαγμένο· στο hover και τα δύο ανεβαίνουν 100% — το πρώτο φεύγει πάνω, το δεύτερο έρχεται από κάτω.
- **Χρόνος:** 400–450ms, `--ease-in-out`.
- **Πού:** links μενού, «ΜΕΝΟΥ», κουμπιά CTA (μαζί με E1).
- **Υλοποίηση:** §4 `.roll` + §5 `<RollText>`.

### E3 — Εμφάνιση ετικέτας (scroll)
- **Τι:** `opacity 0 → 1`, `translateY(10px) → 0` **(μετρημένο: 10px)**.
- **Χρόνος:** 500ms, `--ease-out`.
- **Πού:** G1 ετικέτες.

### E4 — Εμφάνιση μπλοκ τίτλου + υπότιτλου (scroll)
- **Τι:** `opacity 0 → 1`, `translateY(50px) → 0` **(μετρημένο: 50px)**.
- **Χρόνος:** 800ms, `--ease-out`, καθυστέρηση 100ms μετά το E3.
- **Πού:** ενότητες site· στην app μόνο 16px μετατόπιση.

### E5 — Τίτλος λέξη-λέξη (scroll/φόρτωση)
- **Τι:** κάθε λέξη σε `inline-block` span, `opacity ~0 → 1`, `translateY(10px) → 0` **(μετρημένο)**, με stagger.
- **Χρόνος:** 600ms ανά λέξη, stagger 40ms.
- **Πού:** hero site, χαιρετισμός «Καλημέρα, Νίκο», όνομα επιχείρησης στη σελίδα κράτησης.
- **Προσοχή:** ανά **λέξη**, όχι ανά γράμμα (οι αναγνώστες οθόνης διαβάζουν σωστά με `aria-label` στο γονικό + `aria-hidden` στα spans).
- **Υλοποίηση:** §5 `<SplitWords>`.

### E6 — Αριθμοί που μετράνε (scroll/φόρτωση)
- **Τι:** 0 → τελική τιμή, easeOutCubic.
- **Χρόνος:** 1100–1400ms.
- **Πού:** site («2.000+ ραντεβού»), app «Σήμερα» (αναμενόμενα €, αριθμός ραντεβού) — **μόνο στην πρώτη φόρτωση της ημέρας**, όχι σε κάθε refetch.
- **Υλοποίηση:** §5 `useCountUp`. Μορφοποίηση μόνο μέσω `money.ts`.

### E7 — Κάρτες που γλιστράνε πάνω από σταθερό τίτλο (scroll-linked)
- **Τι:** ο τίτλος ενότητας μένει `sticky`· κάρτες με φωτογραφία (με G5) ανεβαίνουν εναλλάξ αριστερά/δεξιά και τον καλύπτουν.
- **Πού:** **μόνο site μάρκετινγκ** («Πώς δουλεύει: 1. Κλείνει 2. Θυμάται 3. Φέρνει πίσω»).
- **Υλοποίηση:** `position: sticky` + κανονικό scroll· χωρίς JS. Προαιρετικά `animation-timeline: view()` με fallback.

### E8 — Μετατοπισμένο περίγραμμα που «έρχεται» (scroll)
- **Τι:** το G5 ξεκινά ταυτισμένο με την κάρτα και γλιστρά στη θέση +10px.
- **Χρόνος:** 700ms, `--ease-out`, 150ms μετά την κάρτα.

### E9 — Gallery σε κάψουλες
- **Τι:** G4 σε οριζόντια σειρά· εμφάνιση με E4 (stagger 80ms)· στο hover (ποντίκι) η εικόνα κάνει `scale(1.04)` μέσα στο mask σε 700ms.
- **Πού:** σελίδα κράτησης («Η δουλειά μας»), site.

### E10 — Κάρτα υπηρεσίας που ανοίγει (hover/tap)
- **Τι:** σκούρο overlay πάνω σε φωτογραφία· στο hover ανεβαίνει λίστα (τι περιλαμβάνει, διάρκεια, τιμή).
- **Χρόνος:** 500ms, `--ease-out`. **Χωρίς animation ύψους**: η λίστα είναι πάντα εκεί, κάνει `translateY(100%) → 0` μέσα σε `overflow: hidden`.
- **Πού:** site· στη σελίδα κράτησης μόνο αν η επιχείρηση ανεβάσει φωτογραφίες υπηρεσιών.

### E11 — Splash φόρτωσης
- **Τι:** οθόνη σε χρώμα άμμου με το λογότυπο, fade-out όταν φορτώσει το hero.
- **Πού:** **μόνο site μάρκετινγκ**, max 800ms, και μόνο στην πρώτη επίσκεψη της συνεδρίας. **Ποτέ** στη σελίδα κράτησης ή στην app.

### E12 — Carousel με στρογγυλά βελάκια
- **Τι:** κάρτες με G5· δύο στρογγυλά espresso κουμπιά (48px) ← →· τελείες ένδειξης· `scroll-snap` για swipe.
- **Χρόνος:** 500ms `--ease-in-out` με τα βελάκια· με δάχτυλο φυσικό scroll.
- **Πού:** site (κριτικές, ομάδα), σελίδα κράτησης (προσωπικό, αν >4).

### E13 — Σταθερή διάφανη κεφαλίδα
- **Τι:** λογότυπο + pill «ΜΕΝΟΥ» πάνω από το hero χωρίς φόντο· μετά από 80px scroll αποκτά φόντο κρεμ 90% + `backdrop-filter: blur(12px)` σε 250ms.
- **Πού:** site, σελίδα κράτησης.

### Κινήσεις δικές μας (ίδιο ύφος, για τις ροές του Anaklo)

| Κωδ. | Κίνηση | Χρόνος | Πού |
|---|---|---|---|
| E14 | **Μετάβαση βημάτων κράτησης**: νέο βήμα `translateX(28px) → 0` + fade· πίσω: αντίστροφα | 420ms `--ease-out` | Σελίδα κράτησης |
| E15 | **Επιβεβαίωση**: κύκλος `scale(.6 → 1.06 → 1)` + κύμα (halo) που σβήνει + ✓ που «ζωγραφίζεται» (`stroke-dashoffset`) | 500ms + 450ms (καθυστ. 350ms) | Τέλος κράτησης |
| E16 | **Πάτημα**: `scale(.97)` | 150ms | Όλα τα κουμπιά σε αφή |
| E17 | **Skeleton shimmer** σε χρώματα άμμου | 1300ms loop | Φόρτωση app & κράτησης |
| E18 | **Δαχτυλίδι ρυθμού** γεμίζει (`stroke-dashoffset`) | 1200ms `cubic-bezier(.3,.7,.2,1)` | Καρτέλα πελάτη, «Σήμερα» |
| E19 | **Μπάρα προόδου** κράτησης | 450ms `--ease-out` (transform: scaleX) | Σελίδα κράτησης |

---

## 4. CSS αναφοράς

```css
/* ---------- E1 υγρό γέμισμα + E2 ρολό ---------- */
.btn-fill {
  position: relative; overflow: hidden; isolation: isolate;
  border-radius: var(--radius-pill);
  transition: color var(--dur-fill) var(--ease-in-out);
}
.btn-fill::before {
  content: ""; position: absolute; z-index: -1;
  left: 50%; top: 100%;
  width: 180%; aspect-ratio: 1; border-radius: 50%;
  background: var(--lux-espresso-deep);
  transform: translate(-50%, 0);
  transition: transform var(--dur-fill) var(--ease-in-out);
}
@media (hover: hover) and (pointer: fine) {
  .btn-fill:hover { color: var(--lux-cream); }
  .btn-fill:hover::before { transform: translate(-50%, -65%); }
}

.roll { display: inline-block; height: 1.25em; line-height: 1.25em; overflow: hidden; vertical-align: middle; }
.roll > span { display: block; transition: transform 450ms var(--ease-in-out); }
@media (hover: hover) and (pointer: fine) {
  :is(a, button):hover .roll > span { transform: translateY(-100%); }
}

/* ---------- E16 πάτημα ---------- */
.pressable { transition: transform var(--dur-press) ease; }
.pressable:active { transform: scale(.97); }

/* ---------- E3/E4/E5 εμφανίσεις (ενεργοποιούνται από useInView → data-inview) ---------- */
.reveal { opacity: 0; transform: translateY(var(--reveal-y, 16px)); }
.reveal[data-inview="true"] {
  opacity: 1; transform: none;
  transition: opacity var(--reveal-dur, var(--dur-slow)) var(--ease-out),
              transform var(--reveal-dur, var(--dur-slow)) var(--ease-out);
  transition-delay: var(--reveal-delay, 0ms);
}
.reveal--eyebrow { --reveal-y: 10px; --reveal-dur: 500ms; }
.reveal--block   { --reveal-y: 50px; --reveal-dur: 800ms; --reveal-delay: 100ms; }

.split-word { display: inline-block; opacity: 0; transform: translateY(10px); }
[data-inview="true"] .split-word {
  opacity: 1; transform: none;
  transition: opacity 600ms var(--ease-out), transform 600ms var(--ease-out);
  transition-delay: calc(var(--i) * var(--stagger));
}

/* ---------- G5/E8 μετατοπισμένο περίγραμμα ---------- */
.framed { position: relative; }
.framed::after {
  content: ""; position: absolute; inset: 0; z-index: -1;
  border: 1px solid var(--lux-bronze); border-radius: inherit;
  transform: translate(0, 0);
  transition: transform var(--dur-slow) var(--ease-out) 150ms;
}
.framed[data-inview="true"]::after { transform: translate(var(--frame-offset), var(--frame-offset)); }

/* ---------- E14 βήματα ---------- */
@keyframes step-in  { from { opacity: 0; transform: translateX(28px); }  to { opacity: 1; transform: none; } }
@keyframes step-back{ from { opacity: 0; transform: translateX(-28px); } to { opacity: 1; transform: none; } }
.step-enter      { animation: step-in  420ms var(--ease-out) both; }
.step-enter-back { animation: step-back 420ms var(--ease-out) both; }

/* ---------- E15 επιβεβαίωση ---------- */
@keyframes pop   { 0% { opacity: 0; transform: scale(.6); } 60% { opacity: 1; transform: scale(1.06); } 100% { transform: scale(1); } }
@keyframes halo  { from { opacity: .5; transform: scale(1); } to { opacity: 0; transform: scale(1.7); } }
@keyframes draw  { from { stroke-dashoffset: var(--len, 48); } to { stroke-dashoffset: 0; } }
.confirm-pop  { animation: pop 500ms var(--ease-out) both; }
.confirm-halo { animation: halo 1100ms ease-out 200ms both; }
.confirm-check{ stroke-dasharray: var(--len, 48); animation: draw 450ms ease-out 350ms both; }

/* ---------- E17 skeleton ---------- */
@keyframes shimmer { from { background-position: -380px 0; } to { background-position: 380px 0; } }
.skeleton {
  background: linear-gradient(90deg, #E4D7C8 0%, #F7F0E6 50%, #E4D7C8 100%);
  background-size: 760px 100%; animation: shimmer 1.3s linear infinite;
  border-radius: 12px;
}

/* ---------- E18 δαχτυλίδι ---------- */
.ring-progress { stroke-dasharray: var(--circ); stroke-dashoffset: var(--circ);
  animation: draw 1.2s cubic-bezier(.3,.7,.2,1) .35s forwards; --len: var(--circ); }

/* ---------- E19 μπάρα ---------- */
.progress-bar { transform-origin: left; transition: transform 450ms var(--ease-out); } /* style: transform: scaleX(0.66) */

/* ---------- ΥΠΟΧΡΕΩΤΙΚΟ ---------- */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
  .reveal, .split-word { opacity: 1 !important; transform: none !important; }
}
```

---

## 5. React hooks/components αναφοράς (TypeScript strict)

```tsx
// src/shared/motion/useReducedMotion.ts
import { useSyncExternalStore } from 'react';
const q = '(prefers-reduced-motion: reduce)';
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => { const m = window.matchMedia(q); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb); },
    () => window.matchMedia(q).matches,
    () => true, // SSR/tests: χωρίς κίνηση
  );
}

// src/shared/motion/useInView.ts — μία φορά, με IntersectionObserver
import { useEffect, useRef, useState } from 'react';
export function useInView<T extends Element>(opts: IntersectionObserverInit = { rootMargin: '0px 0px -10% 0px' }) {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || inView) return;
    if (!('IntersectionObserver' in window)) { setInView(true); return; }
    const io = new IntersectionObserver(([e]) => { if (e?.isIntersecting) { setInView(true); io.disconnect(); } }, opts);
    io.observe(el);
    return () => io.disconnect();
  }, [inView, opts]);
  return { ref, inView } as const; // χρήση: <div ref={ref} className="reveal" data-inview={inView} />
}

// src/shared/motion/useCountUp.ts — E6
import { useEffect, useState } from 'react';
import { useReducedMotion } from './useReducedMotion';
export function useCountUp(target: number, start: boolean, durationMs = 1200): number {
  const reduced = useReducedMotion();
  const [v, setV] = useState(reduced ? target : 0);
  useEffect(() => {
    if (!start || reduced) { setV(target); return; }
    let raf = 0; const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / durationMs);
      setV(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, start, durationMs, reduced]);
  return v;
}

// src/shared/motion/SplitWords.tsx — E5
export function SplitWords({ text, as: Tag = 'span' }: { text: string; as?: 'span' | 'h1' | 'h2' }) {
  const words = text.split(' ');
  return (
    <Tag aria-label={text}>
      {words.map((w, i) => (
        <span key={i} aria-hidden="true" className="split-word" style={{ ['--i' as string]: i }}>
          {w}{i < words.length - 1 ? ' ' : ''}
        </span>
      ))}
    </Tag>
  );
}

// src/shared/motion/RollText.tsx — E2
export function RollText({ children }: { children: string }) {
  return (
    <span className="roll">
      <span>{children}</span>
      <span aria-hidden="true">{children}</span>
    </span>
  );
}
```

> Τα κείμενα (`text`, `children`) έρχονται **πάντα από i18n**.

---

## 6. Έλεγχοι (Definition of Done για την κίνηση)

- [ ] Με `prefers-reduced-motion` όλα εμφανίζονται αμέσως (Playwright: `page.emulateMedia({ reducedMotion: 'reduce' })`).
- [ ] Κανένα layout shift από εμφανίσεις (CLS ≈ 0 — μόνο transform/opacity).
- [ ] Η σελίδα κράτησης μένει < 120 KB JS gzip (ο `check-size` στο CI).
- [ ] Κείμενο πάνω σε G6 (σκούρα φωτογραφία) περνά αντίθεση 4.5:1.
- [ ] Χρυσό (#D4BE6E) **μόνο** σε σκούρο φόντο· σε ανοιχτό χρησιμοποιείται μπρονζέ.
- [ ] Hover εφέ δεν εμφανίζονται σε αφή (δοκιμή σε iPhone).
- [ ] Αναγνώστης οθόνης διαβάζει ολόκληρο τον τίτλο του `<SplitWords>`, όχι λέξη-λέξη.

---

## 7. Τι ΔΕΝ παίρνουμε από το template

- Φωτογραφίες, λογότυπο, εικονίδια, διακοσμητικά SVG → δικά μας ή από τις επιχειρήσεις.
- Κείμενα / δομή σελίδων αυτούσια.
- Κώδικα Framer.
- Playfair Display / Lato ως έχουν (χωρίς ελληνικά) → GFS Didot / Manrope.

*Ζωντανό demo των E1, E2, E5, E6, E8, E14–E19: καμβάς «Anaklo — Κατευθύνσεις σχεδιασμού» → πλαίσιο «Κίνηση» (Play).*
