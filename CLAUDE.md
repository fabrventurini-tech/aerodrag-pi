# AeroDrag — istruzioni di repo (gateway Pi)## Contratto — fonte di verità unica (NON modificare)
Il contratto d'interfaccia è `aerodrag-firmware/docs/CONTRACT.md` su `main`: è l'UNICA
fonte autorevole delle interfacce fra tutti i componenti AeroDrag. Leggilo **da git**
all'avvio (mai da copie/cache). Questo repo lo **implementa**, non lo cambia.
I cambi d'interfaccia si **propongono via seam issue a MOTHER** — l'orchestratore che sta
**sopra tutti i repo** (ruolo/team `@.../mother`), l'unica autorizzata a **editare e
ratificare** il contratto (bump SemVer). Qualsiasi copia del contratto fuori da quel file
è "copia di lavoro, NON autorevole".
