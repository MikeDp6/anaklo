# Runbook: επαναφορά της εφαρμογής κωδικών (mfa-reset)

- **Κατάσταση:** σχέδιο του βήματος 1.7, **προς έγκριση από τον Μιχάλη** (επαλήθευση ταυτότητας, contract 1.7 §9.6). Μέχρι την έγκριση: μόνο τοπικές δοκιμές με `--local`.
- **Πηγές:** ADR-0009 §14–§17, plan `docs/plans/phase-1.md` «## 1.7» (Χαμένη συσκευή και reset από τη Nous), contract `docs/plans/contracts/1.7-security-members.md` §5.1 και §5.3.
- **Εργαλείο:** `scripts/mfa-reset.mjs` (`npm run mfa-reset -- …`). Χωρίς `--yes` κάνει μόνο ξηρή εκτέλεση: δείχνει τι θα γίνει και δεν γράφει τίποτα.

## 1. Πότε

Μόνο όταν ο χρήστης (owner ή manager) έχασε **κάθε** συσκευή κωδικών του: δεν έχει ούτε τη δεύτερη συσκευή, ούτε άλλη εφαρμογή κωδικών με τον ίδιο λογαριασμό.

- Αν έχει δεύτερη συσκευή: δεν χρειάζεται reset. Μπαίνει με τον κωδικό της δεύτερης («Κωδικός από τη δεύτερη συσκευή» στην οθόνη «Χάσατε τη συσκευή σας;») και αντικαθιστά τη χαμένη από τις Ρυθμίσεις → Ασφάλεια (πρώτα προσθήκη της νέας, μετά αφαίρεση της παλιάς).
- Το staff δεν έχει εφαρμογή κωδικών: δεν υπάρχει τίποτα να επαναφερθεί.
- **Ποτέ** reset με αίτημα μόνο από email. Ένα email μπορεί να το στείλει όποιος έχει πάρει τον λογαριασμό email· γι' αυτό η εφαρμογή δεν έχει δρόμο παράκαμψης.

## 2. Επαλήθευση ταυτότητας

Το αίτημα έρχεται μόνο από τον ίδιο τον χρήστη, από γνωστό κανάλι (τηλέφωνο ή email που ήδη γνωρίζουμε). Πριν από οτιδήποτε άλλο, **και τα δύο**:

1. **Κωδικός στο email του λογαριασμού.** Η Nous στέλνει από το δικό της mailbox έναν τυχαίο κωδικό (π.χ. 6 ψηφία) στο email του λογαριασμού στο Anaklo, και ο χρήστης τον λέει πίσω στην κλήση του βήματος 2.
2. **Κλήση πίσω στο τηλέφωνο της επιχείρησης που έχουμε ήδη:** `businesses.phone_e164` ή ο αριθμός του αρχείου provisioning. **Ποτέ** σε αριθμό που δίνεται μέσα στο αίτημα, όσο πειστικός κι αν είναι ο λόγος.

Για **manager**, επιπλέον **γραπτή επιβεβαίωση από τον owner** της επιχείρησης (email από τη διεύθυνση του owner στο Anaklo, ή μήνυμα από το τηλέφωνο της επιχείρησης).

Αν κάτι από τα παραπάνω δεν γίνεται (π.χ. ο χρήστης έχασε και το email του): έλεγχος με βιντεοκλήση ή από κοντά, με ταυτότητα, από κάποιον της Nous που τον γνωρίζει. Αλλιώς **όχι** reset.

## 3. Καταγραφή

Άνοιξε ticket πριν από το script: ποιος ζήτησε, πότε, από ποιο κανάλι, πώς έγινε η επαλήθευση (ποιος κωδικός στάλθηκε πού, σε ποιο τηλέφωνο έγινε η κλήση, η επιβεβαίωση του owner). Ο αριθμός του ticket μπαίνει στο `--ticket` (γράμματα, ψηφία και `. _ # / -`, έως 40) και ο λόγος στο `--reason` (3–400 χαρακτήρες). Και τα δύο γράφονται στο `audit_log` ως `[ticket] λόγος`.

## 4. Εκτέλεση

Πρώτα **ξηρή εκτέλεση** (δεν γράφει τίποτα· δείχνει τον χρήστη, τις επιχειρήσεις όπου είναι owner ή manager και τις συσκευές του, χωρίς μυστικά):

```powershell
npm run mfa-reset -- --email nikos@example.gr --reason "lost phone, identity checked by call-back" --ticket NOUS-123
```

Αν όλα είναι σωστά (σωστός χρήστης, σωστές επιχειρήσεις), το ίδιο με `--yes`:

```powershell
npm run mfa-reset -- --email nikos@example.gr --reason "lost phone, identity checked by call-back" --ticket NOUS-123 --yes
```

- Προεπιλογή είναι το **dev** project (`SUPABASE_DEV_PROJECT_REF`). Το κλειδί `SUPABASE_SECRET_KEY` έρχεται από το περιβάλλον ή από `--env-file <αρχείο εκτός repo>`, ποτέ από το `.env.local`.
- Στο **prod** μόνο ρητά: `--prod --project-ref <ref> --env-file <αρχείο εκτός repo>`.
- Με `--yes`, με αυτή τη σειρά: (1) το id από το `user_id_for_email`· (2) `record_support_action('mfa_reset')`: μία άδεια αφαίρεσης (`nous_support`) για κάθε συσκευή και μία γραμμή `audit_log` (`nous_support`) για κάθε επιχείρηση όπου ο χρήστης είναι owner ή manager, **πριν** σβηστεί οτιδήποτε, ώστε ο ανιχνευτής του 1.9 να μην τη σημειώσει· (3) διαγραφή **όλων** των συσκευών του (`auth.admin.mfa.deleteFactor`)· (4) ανάκληση **όλων** των συνεδριών του (`revoke_user_sessions`, μαζί και οι συσκευές push του).
- Άγνωστο όρισμα → έξοδος 2 πριν από οποιαδήποτε σύνδεση. Άγνωστο email ή χρήστης που δεν είναι owner/manager πουθενά → έξοδος 1, τίποτα γραμμένο.

## 5. Έλεγχος

Το script τυπώνει: άδειες, γραμμές `audit_log`, συσκευές που σβήστηκαν (και όσες είχαν ήδη σβηστεί), συνεδρίες και συσκευές push που ανακλήθηκαν. Έξοδος 0 = ολοκληρώθηκε.

Αν τυπώσει «Failed at step …»: το βήμα που απέτυχε φαίνεται στο μήνυμα. Οι συνεδρίες ανακαλούνται ακόμη κι αν μια διαγραφή συσκευής αποτύχει. Ξανατρέξε την ίδια εντολή με το **ίδιο** ticket (είναι ασφαλές: γράφει νέες άδειες μόνο για ό,τι έχει μείνει). Σημείωσε στο ticket ό,τι έγινε.

## 6. Email

Μετά από επιτυχημένο `--yes` το script τυπώνει έτοιμα τα παρακάτω κείμενα (el και en): προς τον χρήστη, και για manager και προς τους owners της επιχείρησης, με τα email τους. Στείλε από το mailbox της Nous, στη γλώσσα της επιχείρησης. Τα κείμενα δεν έχουν **ποτέ** κωδικούς ή links.

Τα πρότυπα ζουν **εδώ**, ανάμεσα στους δείκτες `<!-- mfa-reset-email:… -->` και `<!-- /mfa-reset-email -->`, που τους διαβάζει το script (Vitest: `scripts/lib/mfa-reset.test.mjs`). Μεταβλητές: `{{email}}` (ο λογαριασμός που επαναφέρθηκε), `{{date}}` (η ώρα της επαναφοράς, στη ζώνη της επιχείρησης), `{{ticket}}`. Άλλη μεταβλητή σταματά το script.

### Προς τον χρήστη (Ελληνικά)

<!-- mfa-reset-email:user:el -->

```text
Θέμα: Επαναφορά της εφαρμογής κωδικών του λογαριασμού σας στο Anaklo

Γεια σας,

Στις {{date}}, μετά από δικό σας αίτημα και αφού επιβεβαιώσαμε την ταυτότητά σας, αφαιρέσαμε τις συσκευές κωδικών του λογαριασμού {{email}} στο Anaklo και αποσυνδέσαμε τον λογαριασμό από όλες τις συσκευές.

Τι κάνετε τώρα:
1. Ανοίξτε την εφαρμογή Anaklo στο κινητό σας και συνδεθείτε με το email σας. Θα σας έρθει κωδικός.
2. Η εφαρμογή θα σας ζητήσει να ορίσετε ξανά εφαρμογή κωδικών (π.χ. Google Authenticator, Microsoft Authenticator ή τους «Κωδικούς» του iPhone).
3. Προσθέστε αμέσως και δεύτερη συσκευή, ώστε αν χάσετε ξανά το κινητό σας να μπαίνετε με τον κωδικό της δεύτερης.

Αν δεν ζητήσατε εσείς αυτή την επαναφορά, απαντήστε αμέσως σε αυτό το email ή τηλεφωνήστε μας.

Αριθμός αιτήματος: {{ticket}}

Η ομάδα της Nous
```

<!-- /mfa-reset-email -->

### Προς τον χρήστη (English)

<!-- mfa-reset-email:user:en -->

```text
Subject: Your Anaklo authenticator app has been reset

Hello,

On {{date}}, at your request and after we confirmed your identity, we removed the authenticator devices of the Anaklo account {{email}} and signed the account out of every device.

What to do now:
1. Open the Anaklo app on your phone and sign in with your email. You will receive a code.
2. The app will ask you to set up an authenticator app again (for example Google Authenticator, Microsoft Authenticator or the iPhone's built-in Passwords).
3. Add a second device straight away, so that if you lose your phone again you can sign in with the second one's code.

If you did not ask for this reset, reply to this email or call us right away.

Request number: {{ticket}}

The Nous team
```

<!-- /mfa-reset-email -->

### Προς τον owner, όταν επαναφέρθηκε manager (Ελληνικά)

<!-- mfa-reset-email:owner:el -->

```text
Θέμα: Επαναφορά της εφαρμογής κωδικών ενός διαχειριστή σας στο Anaklo

Γεια σας,

Στις {{date}}, μετά από αίτημα του διαχειριστή {{email}} και τη γραπτή σας επιβεβαίωση, αφαιρέσαμε τις συσκευές κωδικών του λογαριασμού του στο Anaklo και τον αποσυνδέσαμε από όλες τις συσκευές. Στην επόμενη σύνδεσή του θα ορίσει ξανά εφαρμογή κωδικών.

Αν δεν το γνωρίζατε ή δεν το εγκρίνατε, απαντήστε αμέσως σε αυτό το email ή τηλεφωνήστε μας.

Αριθμός αιτήματος: {{ticket}}

Η ομάδα της Nous
```

<!-- /mfa-reset-email -->

### Προς τον owner, όταν επαναφέρθηκε manager (English)

<!-- mfa-reset-email:owner:en -->

```text
Subject: The authenticator app of one of your managers on Anaklo has been reset

Hello,

On {{date}}, at the request of your manager {{email}} and with your written confirmation, we removed the authenticator devices of their Anaklo account and signed them out of every device. At their next sign-in they will set up an authenticator app again.

If you were not aware of this or did not approve it, reply to this email or call us right away.

Request number: {{ticket}}

The Nous team
```

<!-- /mfa-reset-email -->

## 7. Επόμενη σύνδεση

Ο χρήστης μπαίνει με κωδικό email· η εφαρμογή τον στέλνει στην υποχρεωτική εγγραφή εφαρμογής κωδικών (`decideAuthRoute` → `enroll`) και αμέσως μετά στην οθόνη «Πρόσθεσε δεύτερη συσκευή». Αν κάποια συσκευή του είχε ανοιχτή την εφαρμογή, στην επόμενη κίνηση βρίσκεται στη σύνδεση (οι συνεδρίες ανακλήθηκαν).

## 8. Ποτέ

- Ποτέ reset χωρίς την επαλήθευση του βήματος 2, ποτέ με αίτημα μόνο από email, ποτέ κλήση σε αριθμό από το αίτημα.
- Ποτέ ανάγνωση ή αντιγραφή μυστικών της εφαρμογής κωδικών (το script δεν τα βλέπει: το admin API δεν τα επιστρέφει).
- Ποτέ διαγραφή συσκευών από το dashboard ή με SQL: μόνο με το script, ώστε να γράφονται άδειες και `audit_log`.

## Τοπική πρόβα

Στην τοπική βάση, σε **συνθετικό** χρήστη του seed (π.χ. `manager-reset@demo-barber.test`, αφού έχει γράψει εφαρμογή κωδικών):

```powershell
node scripts/mfa-reset.mjs --local --email manager-reset@demo-barber.test --reason "local rehearsal" --ticket LOCAL-1
node scripts/mfa-reset.mjs --local --email manager-reset@demo-barber.test --reason "local rehearsal" --ticket LOCAL-1 --yes
```

Το `--local` δεν συνδυάζεται με `--prod`, `--project-ref` ή `--env-file`. Το Playwright `e2e/mfa-reset.spec.ts` τρέχει την ίδια ροή.
