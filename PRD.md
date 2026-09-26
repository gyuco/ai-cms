# PRD — AI-CMS

> Documento **funzionale** dei requisiti di prodotto.
> Descrive *cosa* fa il sistema e *per chi*, non *come* è implementato
> (per quello vedi `TECHNICAL.md`).

| Campo | Valore |
|---|---|
| Stato | Bozza v0.1 |
| Data | 2026-09-26 |
| Ambito della prima release | Ambiente locale (Docker) |

---

## 1. Visione

AI-CMS è un CMS in cui **tutto si crea e si modifica parlando con un'AI**:
pagine statiche, pagine dinamiche, strutture dati, logica applicativa e codice.
Non ci sono editor visuali né form da compilare: l'interfaccia principale è una chat.

**Non esiste un pannello di amministrazione.** Il sito stesso è l'interfaccia: chi ha fatto
l'accesso vede su ogni pagina un **widget** con la chat e gli strumenti di gestione. Chi
visita il sito non vede nulla di tutto questo.

Al primo avvio il sito è **una pagina bianca**: tutto si costruisce da lì, parlando con l'AI,
producendo sempre HTML corretto e semantico.

Per rendere sicuro un sistema in cui l'AI scrive anche codice, AI-CMS si basa su tre pilastri:

1. **Due ambienti separati.** In **Produzione** si possono modificare solo i contenuti statici.
   In **Staging** si sviluppa e si testa tutto il resto, che arriva in produzione solo dopo
   verifica e approvazione.
2. **Permessi atomici come in un filesystem Linux.** Ogni elemento del sito è un nodo
   in un albero, con proprietario, gruppo, permessi e ACL. Si stabilisce con precisione
   chi può fare cosa e dove.
3. **L'AI non ha più poteri di chi la usa.** L'agente AI agisce sempre per conto di un
   utente, con i permessi di quell'utente, ulteriormente ristretti dal profilo dell'agente.

---

## 2. Glossario

| Termine | Significato |
|---|---|
| **Nodo** | Qualsiasi elemento gestito dal CMS: cartella, pagina, blocco, asset, collezione, record, file di codice, impostazione. |
| **Albero** | La gerarchia dei nodi, navigabile per percorso (es. `/site/pages/blog/primo-post`). |
| **Pagina statica** | Pagina composta solo da contenuto (testo, blocchi, immagini, HTML/CSS). Non contiene logica server. |
| **Pagina dinamica** | Pagina che contiene anche codice: legge dati da un database, riceve parametri, esegue logica. |
| **Collezione** | Un tipo di dato strutturato (es. "Prodotti") con uno schema e dei record. |
| **Contenuto** | Tutto ciò che non è codice né schema: testi, blocchi, asset, metadati SEO, menu. |
| **Codice** | File sorgente, componenti, API, logica server, schemi dati, migrazioni. |
| **Changeset** | Un insieme di modifiche al codice prodotte in una sessione di sviluppo, testate insieme e pubblicate insieme. |
| **Release** | Un changeset approvato e portato in produzione. |
| **Ambiente** | *Produzione* (sito pubblico) o *Staging* (ambiente parallelo di sviluppo e test). |
| **Widget** | Il pannello flottante che compare su ogni pagina del sito agli utenti autenticati: contiene la chat e gli strumenti di gestione. |
| **Agente contenuti** | L'AI disponibile in produzione, che può solo gestire contenuti. |
| **Agente sviluppatore** | L'AI disponibile in staging, che può scrivere codice e schemi. |
| **Provider AI** | Un fornitore di modelli AI (es. Anthropic, OpenAI, Google, Mistral, un modello locale). |
| **Connessione AI** | Il modo in cui il CMS usa un provider: con una **chiave API** (pagamento a consumo), con un **abbonamento** (piano fisso, tramite lo strumento ufficiale del provider) oppure con un **modello locale**. |
| **Utente** | Una persona con credenziali di accesso. |
| **Gruppo** | Un insieme di utenti. I ruoli sono gruppi. |
| **Capability** | Un permesso di sistema non legato a un nodo (es. "approvare una release"). |

---

## 3. Utenti tipo (personas)

| Persona | Obiettivo | Cosa fa tipicamente |
|---|---|---|
| **Amministratore** | Governare la piattaforma | Crea utenti e gruppi, assegna permessi, configura gli agenti, vede l'audit. |
| **Sviluppatore / maker** | Far evolvere il sito | Chiede all'agente sviluppatore nuove pagine dinamiche, collezioni, integrazioni. |
| **Redattore** | Mantenere i contenuti aggiornati | Chiede all'agente contenuti di creare o modificare pagine e testi. |
| **Autore** | Scrivere contenuti propri | Crea e modifica solo i propri contenuti in un'area assegnata. |
| **Revisore / Release manager** | Garantire la qualità | Esamina i changeset in staging e approva o rifiuta il passaggio in produzione. |
| **Visitatore** | Usare il sito pubblico | Naviga il sito. Non ha accesso al CMS. |

---

## 4. Ambienti

### 4.1 Produzione

- È il sito pubblico.
- **Si possono modificare solo i contenuti statici**: testi, blocchi, immagini, asset,
  metadati, menu, pagine statiche.
- **Non si possono modificare** codice, schemi delle collezioni, API, logica delle pagine dinamiche.
  Questo vale **per chiunque, amministratori inclusi**: il codice entra in produzione solo tramite una release.
- Ogni modifica ai contenuti è versionata, visibile in anteprima prima di essere pubblicata e annullabile.
- I dati inseriti dai visitatori o dalle funzionalità del sito (es. ordini, form) vivono in produzione
  e sono gestiti secondo i permessi sulle collezioni.

### 4.2 Staging

- È un ambiente parallelo, completo e isolato: sito, dati e asset propri.
- Qui l'agente sviluppatore può creare e modificare **qualsiasi cosa**: codice, pagine dinamiche,
  collezioni, schemi, componenti, layout.
- I dati di staging sono separati da quelli di produzione. Si possono aggiornare su richiesta
  con una copia dei contenuti di produzione e con dati di esempio o anonimizzati.
- Nessuna modifica fatta in staging raggiunge la produzione senza una release approvata.

### 4.3 Direzione dei flussi

| Cosa | Direzione | Come |
|---|---|---|
| Codice, schemi, pagine dinamiche | Staging → Produzione | Tramite release approvata |
| Contenuti | Produzione → Staging | Tramite sincronizzazione su richiesta o pianificata |

Così staging lavora sempre su contenuti realistici e la produzione riceve solo codice verificato.

---

## 5. Requisiti funzionali

Ogni requisito ha un identificativo (`FR-xx`) e una priorità: **M** = must, **S** = should, **C** = could.

### 5.1 Chat e agenti AI

| ID | Requisito | Priorità |
|---|---|---|
| FR-01 | L'utente interagisce con il CMS tramite una chat in linguaggio naturale. | M |
| FR-02 | La chat indica sempre in quale ambiente si trova (Produzione o Staging) e con quale agente si sta parlando. | M |
| FR-03 | In produzione è disponibile solo l'agente contenuti; in staging è disponibile l'agente sviluppatore (e anche l'agente contenuti per i contenuti di staging). | M |
| FR-04 | L'agente agisce **per conto dell'utente**: non può mai fare ciò che l'utente non ha il permesso di fare. | M |
| FR-05 | Se l'utente chiede qualcosa che non ha il permesso di fare, l'agente lo spiega indicando quale permesso manca e su quale nodo. | M |
| FR-06 | Prima di operazioni distruttive (eliminazioni, sovrascritture massive, modifiche a schemi con perdita di dati) l'agente chiede conferma esplicita. | M |
| FR-07 | L'agente mostra un riepilogo delle modifiche che intende fare (anteprima o diff) prima di applicarle. | M |
| FR-08 | La conversazione è salvata e collegata alle modifiche che ha prodotto (da una versione si risale alla conversazione e viceversa). | S |
| FR-09 | L'utente può allegare file (immagini, documenti, CSV) che l'agente può usare come contenuto o come dati da importare. | S |
| FR-10 | L'amministratore può configurare per ogni agente il provider e il modello AI, le istruzioni di base, gli strumenti disponibili e i limiti di spesa (vedi 5.10). | M |
| FR-11 | Più utenti possono lavorare in parallelo in chat diverse senza sovrascriversi (vedi 5.6 sui conflitti). | M |

### 5.2 Pagine statiche e contenuti

| ID | Requisito | Priorità |
|---|---|---|
| FR-20 | Creare, modificare, spostare, rinominare ed eliminare pagine statiche tramite chat. | M |
| FR-21 | Una pagina è composta da blocchi (titolo, testo, immagine, galleria, HTML libero, ecc.) e da metadati (titolo, descrizione SEO, slug, immagine social). | M |
| FR-22 | L'agente può generare HTML e CSS liberi per una pagina o un blocco, entro le regole di sicurezza (niente script arbitrari in produzione, vedi FR-112). | M |
| FR-23 | Gestione di layout, header, footer e menu di navigazione. | M |
| FR-24 | Caricamento e gestione di asset (immagini, PDF, video) con testo alternativo e ridimensionamento automatico delle immagini. | M |
| FR-25 | Ogni pagina ha uno stato: **bozza**, **pubblicata**, **programmata**, **archiviata**. | M |
| FR-26 | Pubblicazione programmata a data e ora. | S |
| FR-27 | Anteprima di una bozza, condivisibile tramite link temporaneo. | S |
| FR-28 | Contenuti multilingua: stessa pagina in più lingue, con traduzione assistita dall'AI. | C |

### 5.3 Pagine dinamiche, collezioni e codice (solo staging)

| ID | Requisito | Priorità |
|---|---|---|
| FR-30 | Creare collezioni (tipi di dato) descrivendole in chat: campi, tipi, validazioni, relazioni. | M |
| FR-31 | Modificare lo schema di una collezione esistente, con indicazione chiara dell'impatto sui dati esistenti. | M |
| FR-32 | Creare pagine dinamiche: elenchi, dettagli, ricerche, filtri, paginazione, basati sulle collezioni. | M |
| FR-33 | Creare endpoint API (es. ricezione di un form, un webhook, un feed). | M |
| FR-34 | Creare componenti riutilizzabili e usarli sia nelle pagine statiche sia in quelle dinamiche. | M |
| FR-35 | L'agente sviluppatore scrive codice vero, senza limiti a un insieme di blocchi predefiniti. | M |
| FR-36 | Ogni sessione di sviluppo produce un **changeset** con: descrizione, elenco dei file e degli schemi toccati, diff leggibile, risultato dei controlli. | M |
| FR-37 | L'aggiunta di librerie esterne richiede un permesso specifico. | M |
| FR-38 | L'agente sviluppatore non ha mai accesso ai dati o alle credenziali di produzione. | M |
| FR-39 | Gestione dei dati delle collezioni (inserire, modificare, importare, esportare record) tramite chat, secondo i permessi. | M |

### 5.4 Controlli automatici su staging

| ID | Requisito | Priorità |
|---|---|---|
| FR-40 | Ogni changeset viene verificato automaticamente prima di poter essere proposto per la release. | M |
| FR-41 | I controlli includono almeno: correttezza del codice, stile, test automatici, build del sito, applicazione delle modifiche agli schemi, test end-to-end delle pagine toccate. | M |
| FR-42 | Se un controllo fallisce, l'agente riceve l'errore e prova a correggerlo da solo, entro un numero massimo di tentativi configurabile. | M |
| FR-43 | Un'AI revisore separata esamina il changeset e segnala problemi di sicurezza, qualità e regressioni. | S |
| FR-44 | L'utente vede lo stato di ogni controllo e un link al sito di staging per provare le modifiche. | M |

### 5.5 Release (staging → produzione)

| ID | Requisito | Priorità |
|---|---|---|
| FR-50 | Un changeset che ha superato i controlli può essere **proposto per la release**. | M |
| FR-51 | La release richiede l'approvazione di **un solo revisore** con la capability di approvazione. L'approvazione è **un solo clic** ("Approva e pubblica"): approva ed esegue la release. | M |
| FR-52 | Separazione dei compiti: chi ha creato un changeset non può approvarlo da solo. **Disattivata di default**, attivabile in seguito dall'amministratore. | C |
| FR-53 | Il revisore vede diff, descrizione, esito dei controlli, impatto sugli schemi e la conversazione che ha generato il changeset. | M |
| FR-54 | Il revisore può approvare o rifiutare con un commento facoltativo; il commento di un rifiuto torna all'agente sviluppatore come richiesta di modifiche. | M |
| FR-55 | La release porta in produzione codice e modifiche agli schemi insieme, in modo che il sito non resti mai in uno stato intermedio. | M |
| FR-56 | Prima di applicare modifiche agli schemi in produzione viene salvata una copia di sicurezza dei dati interessati. | M |
| FR-57 | **Rollback** di una release con un comando, riportando il codice alla release precedente. | M |
| FR-58 | Più changeset possono essere raggruppati in una sola release. | C |
| FR-59 | Storico delle release con autore, approvatore, data, contenuto ed esito. | M |

### 5.6 Versioni, conflitti e annullamento

| ID | Requisito | Priorità |
|---|---|---|
| FR-60 | Ogni modifica a un nodo crea una nuova versione; le versioni precedenti restano consultabili. | M |
| FR-61 | Confronto tra due versioni di un nodo. | S |
| FR-62 | Ripristino di una versione precedente. | M |
| FR-63 | Un'operazione richiesta in chat che tocca più nodi viene applicata **per intero o per niente**: mai a metà. | M |
| FR-64 | Se due utenti modificano lo stesso nodo, il secondo che salva viene avvisato del conflitto e l'agente propone un'unione. | M |
| FR-65 | Due changeset in staging che toccano gli stessi file vengono segnalati come in conflitto prima della release. | M |
| FR-66 | Cestino: i nodi eliminati sono recuperabili per un periodo configurabile. | S |

### 5.7 Utenti, gruppi e permessi

Il modello è ispirato al filesystem Linux. Obiettivo: **ogni azione su ogni nodo è autorizzata
da un permesso atomico**, e le regole si leggono come su un filesystem.

> **Fase 1 (MVP 1):** tutti gli utenti autenticati sono **amministratori**. Restano attivi i
> vincoli di sistema (es. codice non modificabile in produzione) e i limiti degli agenti AI
> (5.7.9). Il modello descritto in questa sezione arriva in **fase 2**; il sistema è già
> predisposto perché ogni azione passa da un unico punto di autorizzazione.

#### 5.7.1 Utenti

| ID | Requisito | Priorità |
|---|---|---|
| FR-70 | Creare, sospendere, riattivare ed eliminare utenti. Un utente eliminato resta nell'audit. | M |
| FR-71 | Invito via email, accesso con email e password, recupero password. | M |
| FR-72 | Autenticazione a due fattori (TOTP), obbligatoria per chi ha capability sensibili. | S |
| FR-73 | Un utente speciale **root** con tutti i permessi, soggetto comunque ai vincoli di sistema (es. codice immutabile in produzione). | M |
| FR-74 | Ogni utente ha un **gruppo primario** e può appartenere ad altri gruppi. | M |
| FR-75 | Account di servizio (non umani) e token API con permessi limitati e scadenza. | S |
| FR-76 | Scadenza dei permessi: l'appartenenza a un gruppo o una regola di accesso può avere una data di fine. | S |

#### 5.7.2 L'albero dei nodi

Tutto ciò che il CMS gestisce vive in un unico albero, come un filesystem:

```
/
├── site/
│   ├── pages/          pagine (statiche e dinamiche), una cartella per pagina
│   ├── layouts/        layout, header, footer
│   ├── components/     componenti riutilizzabili
│   ├── menus/          menu di navigazione
│   └── assets/         immagini, file, media
├── data/
│   └── collections/    una cartella per collezione: schema e record
├── code/
│   ├── api/            endpoint
│   ├── lib/            logica condivisa
│   └── migrations/     modifiche agli schemi
├── releases/           changeset e release
└── system/
    ├── users/  groups/  agents/  settings/  secrets/
```

- Ogni pagina è una **cartella**: contiene il contenuto (blocchi, metadati) e, se è dinamica, anche i file di codice.
  Una pagina statica si riconosce perché contiene solo contenuto.
- Ogni nodo ha: **proprietario** (utente), **gruppo**, **permessi** (mode), **ACL** opzionale, **attributi**.

#### 5.7.3 Permessi atomici

Ogni permesso autorizza **un solo tipo di azione**:

| Lettera | Permesso | Su un nodo | Su una cartella |
|---|---|---|---|
| `r` | read | leggere il contenuto (incluse le bozze) | leggere i metadati della cartella |
| `l` | list | — | elencare i figli |
| `x` | traverse / execute | eseguire (es. invocare un'API, lanciare una query) | attraversarla per raggiungere i figli |
| `w` | write | modificare il contenuto (crea una nuova versione) | modificare i metadati della cartella |
| `c` | create | — | creare figli |
| `d` | delete | eliminare o spostare il nodo | — |
| `p` | publish | pubblicare in produzione (contenuti) o proporre per la release (codice) | idem, sui figli |
| `m` | manage | cambiare permessi, ACL, gruppo e (con capability) proprietario | idem |

I permessi sono espressi per tre classi, come in Linux:

- **u** (owner): il proprietario del nodo
- **g** (group): i membri del gruppo del nodo
- **o** (other): tutti gli altri utenti autenticati

Esempio di rappresentazione: `u=rlxwcdpm g=rlxwc o=rlx`.

Scorciatoie compatibili con Linux: `r` classico = `rl`, `w` classico = `wcd`, `x` classico = `x`.
Quindi un `chmod 755` corrisponde a `u=rlxwcd g=rlx o=rlx`.

#### 5.7.4 ACL (liste di controllo accessi)

| ID | Requisito | Priorità |
|---|---|---|
| FR-77 | Oltre a u/g/o, ogni nodo può avere regole aggiuntive per **utenti o gruppi specifici** (es. "il gruppo *traduttori* può scrivere in `/site/pages/en`"). | M |
| FR-78 | Le regole possono essere di tipo **consenti** o **nega**. Un *nega* vince sempre su un *consenti*. | M |
| FR-79 | Ogni cartella può avere **ACL di default** che vengono ereditate automaticamente dai nodi creati al suo interno. | M |
| FR-80 | Una **maschera** su un nodo limita il massimo dei permessi concedibili tramite ACL e gruppo (come la mask POSIX). | S |
| FR-81 | Una regola può essere limitata a un ambiente (solo Produzione, solo Staging, entrambi). | M |

#### 5.7.5 Regole di valutazione (come si decide se un'azione è permessa)

L'utente può compiere l'azione **A** sul nodo **N** se e solo se, nell'ordine:

1. **Vincoli di sistema.** L'azione non viola un vincolo non aggirabile, ad esempio:
   codice e schemi sono in sola lettura in produzione, anche per root.
2. **Attraversamento.** L'utente ha `x` su **tutte** le cartelle antenate di N
   (come in Linux: senza `x` su `/site` non si raggiunge nulla al suo interno).
3. **Negazioni.** Nessuna regola *nega* per l'utente o per uno dei suoi gruppi copre A su N.
4. **Permesso effettivo.** Si individua **una sola classe**, nell'ordine:
   - se l'utente è il **proprietario** → valgono i permessi `u`;
   - altrimenti, se esiste una regola ACL per quell'**utente** → vale quella (limitata dalla maschera);
   - altrimenti, se l'utente appartiene al **gruppo del nodo** o a gruppi con regole ACL →
     vale l'unione dei loro permessi (limitata dalla maschera);
   - altrimenti → valgono i permessi `o`.

   A deve essere contenuta nel permesso effettivo.
5. **Root** salta i passi 2–4, ma non il passo 1.

Questo ordine è quello di Linux ed è **deterministico**: lo stesso utente, sullo stesso nodo,
per la stessa azione ottiene sempre la stessa risposta, spiegabile passo per passo.

#### 5.7.6 Attributi speciali (come i bit speciali di Linux)

| Attributo | Equivalente Linux | Effetto |
|---|---|---|
| **setgid** su cartella | `chmod g+s` | I nodi creati dentro ereditano il gruppo della cartella, non il gruppo primario di chi li crea. |
| **sticky** su cartella | `chmod +t` | Dentro la cartella ognuno può eliminare o spostare solo i nodi di cui è proprietario (utile per aree di più autori). |
| **immutable** | `chattr +i` | Il nodo non può essere modificato né eliminato da nessuno finché l'attributo non viene tolto (richiede una capability). |
| **append-only** | `chattr +a` | Si possono solo aggiungere figli o record, mai modificarli o eliminarli (es. log, ordini). |

#### 5.7.7 Capability di sistema

Alcune azioni non riguardano un nodo ma la piattaforma. Sono concesse a utenti o gruppi
come le capability di Linux:

| Capability | Consente di |
|---|---|
| `CAP_USER_ADMIN` | creare, sospendere ed eliminare utenti |
| `CAP_GROUP_ADMIN` | creare gruppi e gestire le appartenenze |
| `CAP_CHOWN` | cambiare il proprietario di qualsiasi nodo |
| `CAP_ATTR` | impostare o togliere gli attributi immutable e append-only |
| `CAP_RELEASE_APPROVE` | approvare una release |
| `CAP_RELEASE_DEPLOY` | eseguire una release approvata e fare rollback |
| `CAP_STAGING_SYNC` | sincronizzare contenuti e dati da produzione a staging |
| `CAP_DEPENDENCY_ADD` | autorizzare l'aggiunta di librerie esterne |
| `CAP_SECRETS` | gestire credenziali e chiavi (mai leggibili dagli agenti) |
| `CAP_AGENT_CONFIG` | configurare modelli, istruzioni e limiti degli agenti |
| `CAP_AUDIT_READ` | consultare il registro di audit completo |

#### 5.7.8 Gruppi predefiniti

Il sistema nasce con questi gruppi, tutti modificabili:

| Gruppo | Scopo | Permessi di partenza |
|---|---|---|
| `admins` | Amministrazione | Tutte le capability tranne quelle di release. `rlxwcdpm` su tutto l'albero. |
| `release-managers` | Approvazione | `CAP_RELEASE_APPROVE`, `CAP_RELEASE_DEPLOY`. `rlx` su tutto. |
| `developers` | Sviluppo | `rlxwcdp` su `/site`, `/data`, `/code` in **staging**. `rlx` in produzione. |
| `editors` | Redazione | `rlxwcdp` su `/site/pages`, `/site/assets`, `/site/menus` in entrambi gli ambienti. |
| `authors` | Scrittura | `rlxc` su aree assegnate con sticky bit; `wd` solo sui propri nodi. Niente `p`: serve un editor per pubblicare. |
| `viewers` | Consultazione | `rlx` su `/site`. |

#### 5.7.9 Permessi degli agenti AI

| ID | Requisito | Priorità |
|---|---|---|
| FR-82 | I permessi effettivi di un agente sono **l'intersezione** tra i permessi dell'utente che lo usa e il **profilo dell'agente**. | M |
| FR-83 | Il profilo dell'agente contenuti esclude sempre la scrittura di codice e schemi. | M |
| FR-84 | Il profilo dell'agente sviluppatore è valido solo in staging. | M |
| FR-85 | Nessun agente può mai avere `m` sui nodi di `/system`, capability di gestione utenti, di approvazione o sui segreti, anche se l'utente le possiede. | M |
| FR-86 | Un utente può restringere ulteriormente l'agente per una singola conversazione (es. "lavora solo in `/site/pages/blog`"). | S |

#### 5.7.10 Strumenti di gestione dei permessi

| ID | Requisito | Priorità |
|---|---|---|
| FR-87 | Visualizzare per ogni nodo proprietario, gruppo, mode, ACL e attributi, come `ls -l` e `getfacl`. | M |
| FR-88 | **"Perché?"** Dato un utente, un nodo e un'azione, il sistema spiega la decisione passo per passo (quale regola ha concesso o negato). | M |
| FR-89 | **"Chi può?"** Dato un nodo e un'azione, elencare tutti gli utenti che possono compierla. | S |
| FR-90 | **"Cosa può?"** Dato un utente, mostrare i suoi permessi effettivi sull'albero. | S |
| FR-91 | I permessi si possono gestire anche in chat (es. "dai al gruppo traduttori la scrittura su /site/pages/en"), sempre con conferma e solo se si ha `m`. | M |
| FR-92 | Simulazione: vedere l'effetto di una modifica ai permessi prima di applicarla. | C |

### 5.8 Audit e tracciabilità

| ID | Requisito | Priorità |
|---|---|---|
| FR-100 | Ogni azione (lettura di dati sensibili, modifica, permesso negato, login, release) è registrata con: chi, per conto di chi (utente o agente), cosa, dove, quando, esito. | M |
| FR-101 | Il registro di audit non è modificabile da nessuno, root compreso. | M |
| FR-102 | Filtri per utente, nodo, azione, periodo ed esito. | M |
| FR-103 | Esportazione del registro. | S |

### 5.9 Sicurezza del sito pubblicato

| ID | Requisito | Priorità |
|---|---|---|
| FR-110 | Il codice generato non può leggere segreti se non tramite canali autorizzati e dichiarati. | M |
| FR-111 | Il codice generato non può chiamare servizi esterni non autorizzati dall'amministratore. | M |
| FR-112 | HTML e script inseriti come contenuto in produzione sono filtrati: gli script sono consentiti solo tramite componenti approvati passati per una release. | M |
| FR-113 | Protezione dei form pubblici da spam e abusi (limite di richieste). | S |

### 5.10 Modelli e provider AI

Il CMS **non dipende da un solo fornitore di AI**. Si possono collegare più provider e scegliere
quale usare per ogni agente, anche sfruttando gli abbonamenti a prezzo fisso.

#### 5.10.1 Tipi di connessione

| Tipo | Come si paga | Esempi | Uso tipico |
|---|---|---|---|
| **Chiave API** | A consumo (per token) | Anthropic, OpenAI, Google Gemini, Mistral, OpenRouter, qualsiasi servizio compatibile con l'API OpenAI | Tutti gli agenti |
| **Abbonamento** | Piano fisso mensile | Claude Pro/Max tramite Claude Code; piani ChatGPT tramite Codex CLI; piani Google tramite Gemini CLI | Soprattutto l'agente sviluppatore |
| **Modello locale** | Gratis (gira sul tuo computer) | Ollama, LM Studio, vLLM | Prove, compiti semplici, privacy totale |

Con un **abbonamento** il CMS non chiama direttamente le API del provider: fa lavorare lo
**strumento ufficiale da riga di comando** del provider (es. Claude Code), in cui l'utente ha
fatto il login con il **proprio** account. È il modo previsto dai provider per usare il piano
fisso; i consumi rientrano nei limiti del piano, non in una fattura a consumo.

#### 5.10.2 Requisiti

| ID | Requisito | Priorità |
|---|---|---|
| FR-120 | Collegare più provider contemporaneamente, di tutti e tre i tipi. | M |
| FR-121 | Per ogni **ruolo AI** (agente contenuti, agente sviluppatore, revisore AI, traduzioni, generazione di testi alternativi) scegliere provider e modello. | M |
| FR-122 | Per ogni ruolo indicare un'**alternativa di riserva**: se il provider principale non risponde o ha esaurito i limiti del piano, il CMS passa alla riserva e lo segnala in chat. | S |
| FR-123 | Pulsante **"Prova connessione"**: verifica credenziali, modello e capacità richieste (uso di strumenti, lettura di immagini). | M |
| FR-124 | Il CMS impedisce di assegnare a un ruolo un modello privo delle capacità necessarie (es. un modello senza uso di strumenti non può fare da agente). | M |
| FR-125 | **Abbonamenti personali:** ogni utente collega il **proprio** abbonamento con il login ufficiale del provider. Un abbonamento non viene mai condiviso tra più utenti del CMS. | M |
| FR-126 | Il CMS non vede e non salva mai la password dell'account del provider: il login avviene sempre con la procedura ufficiale del provider. | M |
| FR-127 | Le chiavi API sono segreti: si inseriscono una volta, non sono più visualizzabili e non sono mai accessibili agli agenti. | M |
| FR-128 | Chiavi API **condivise** (configurate dall'amministratore, usate da tutti) o **personali** (di un singolo utente). | S |
| FR-129 | Cruscotto consumi per utente, ruolo e provider: token e costo stimato per le chiavi API; numero di richieste e avvisi di limite per gli abbonamenti. | S |
| FR-130 | Limite di spesa mensile per le chiavi API, per utente e totale, con blocco o avviso al superamento. | S |
| FR-131 | L'utente può cambiare modello per una singola conversazione, scegliendo tra quelli che l'amministratore gli consente. | C |
| FR-132 | Le regole sui permessi (5.7) valgono **allo stesso modo con qualsiasi provider**: cambiare modello non cambia mai ciò che l'agente può fare. | M |

#### 5.10.3 Configurazione di partenza (fase 1)

In fase 1 basta **una sola connessione** per iniziare: l'utente sceglie un abbonamento
(es. Claude Code) **oppure** una chiave API, e il CMS la usa per tutti i ruoli.
Riserve, limiti di spesa e cruscotto arrivano dopo.

### 5.11 Interfaccia: il widget in pagina

| ID | Requisito | Priorità |
|---|---|---|
| FR-140 | **Non esiste un'area di amministrazione separata.** Tutta la gestione del CMS avviene dalle pagine del sito. | M |
| FR-141 | L'accesso avviene da un indirizzo dedicato (es. `/_cms/login`), l'unica pagina che non fa parte del sito. Dopo il login si torna alla pagina da cui si è partiti. | M |
| FR-142 | Su **ogni pagina**, un utente autenticato vede un widget flottante, apribile e richiudibile, spostabile, con scorciatoia da tastiera. | M |
| FR-143 | I visitatori non autenticati **non scaricano** il widget e non ne vedono traccia; le pagine restano leggere e identiche per tutti. | M |
| FR-144 | Il widget contiene la **chat** e delle schede di gestione (pagina corrente, sito, sviluppo, utenti e permessi, AI, audit). Ogni utente vede **solo le schede e le azioni permesse** dai suoi permessi. | M |
| FR-145 | La chat conosce la **pagina corrente**: "cambia il titolo" si riferisce alla pagina in cui ci si trova. | M |
| FR-146 | **Selezione sulla pagina:** l'utente può cliccare un elemento (un titolo, un'immagine, una sezione) per indicarlo alla chat. | S |
| FR-147 | **Anteprima sul posto:** le modifiche proposte appaiono direttamente nella pagina, evidenziate, prima della conferma. | M |
| FR-148 | Il widget indica chiaramente l'ambiente (Produzione / Staging) e permette di passare dall'uno all'altro restando sulla stessa pagina. | M |
| FR-149 | Il widget non altera l'aspetto del sito (stili isolati) ed è accessibile (WCAG 2.1 AA). | M |
| FR-150 | Le bozze non ancora pubblicate si possono visitare al loro indirizzo e dal widget, ma solo da chi ha i permessi di lettura; per i visitatori non esistono. | M |

#### Pagina iniziale

| ID | Requisito | Priorità |
|---|---|---|
| FR-151 | Al primo avvio il sito ha **una sola pagina, la home, completamente bianca**: nessun tema, header, footer o menu predefinito. | M |
| FR-152 | La home bianca è comunque un documento HTML valido, con lingua e titolo del sito. | M |
| FR-153 | La home è modificabile come qualsiasi altra pagina, dal widget. | M |

### 5.12 Qualità dell'HTML

Ogni pagina prodotta, statica o dinamica, **deve rispettare le regole dell'HTML**.
L'agente le conosce, le applica da solo e corregge gli errori prima di proporre una modifica.

| ID | Requisito | Priorità |
|---|---|---|
| FR-160 | Le pagine sono **HTML5 valido**. | M |
| FR-161 | **Head completo:** lingua della pagina, codifica, viewport, `<title>` unico nel sito, descrizione, URL canonico, dati per la condivisione social (Open Graph). | M |
| FR-162 | **Titoli:** esattamente un `<h1>` per pagina con contenuto; livelli in ordine, senza salti (`h2` → `h4` non è ammesso); i titoli descrivono la struttura della pagina. | M |
| FR-163 | **Struttura semantica:** un solo `<main>`; uso corretto di `<header>`, `<nav>`, `<footer>`, `<article>`, `<section>`, `<aside>`. | M |
| FR-164 | **Accessibilità di base:** testo alternativo per le immagini, link e pulsanti con testo comprensibile, etichette nei form, contrasto sufficiente (NFR-07). | M |
| FR-165 | Header, footer e menu sono **elementi condivisi del sito**: si modificano una volta e valgono per tutte le pagine. | M |
| FR-166 | Titolo, descrizione e dati social di ogni pagina si possono vedere e modificare dal widget o dalla chat. | M |
| FR-167 | `sitemap.xml` e `robots.txt` sono generati automaticamente dalle pagine pubblicate. | M |
| FR-168 | Gli errori gravi **bloccano la pubblicazione** (es. due `<h1>`, titolo mancante); quelli minori sono avvisi (es. descrizione troppo lunga). L'utente vede sempre il motivo. | M |

---

## 6. Flussi principali

### 6.1 Modifica di una pagina statica in produzione

1. Il redattore, autenticato, naviga sul sito fino alla pagina Contatti e apre il widget.
2. Scrive in chat: "Aggiorna gli orari di apertura".
3. L'agente contenuti verifica i permessi (`w` sul nodo `/site/pages/contatti`) e le regole HTML.
4. La modifica appare in anteprima direttamente nella pagina, con le differenze evidenziate.
5. Il redattore conferma. Viene creata una nuova versione in bozza.
6. Se il redattore ha `p`, pubblica; altrimenti la bozza resta in attesa di un editor.
7. La pagina pubblica si aggiorna senza nuovo deploy. La modifica è annullabile.

### 6.2 Primo avvio

1. Si avvia il sistema: il sito mostra una pagina bianca.
2. Root accede da `/_cms/login` e torna sulla home, ora con il widget.
3. Dal widget collega una connessione AI (abbonamento o chiave API).
4. Scrive in chat: "Crea un sito per il mio studio di architettura: home con presentazione,
   pagine Progetti, Chi siamo e Contatti, con header e menu".
5. L'agente propone struttura, layout condiviso e contenuti; l'anteprima appare sulla home.
6. Root conferma e pubblica.

### 6.3 Nuova funzionalità dinamica

1. Lo sviluppatore apre il widget sul sito di **Staging**: "Voglio un catalogo prodotti con filtri per categoria e prezzo".
2. L'agente sviluppatore propone un piano: collezione `prodotti`, pagine elenco e dettaglio, componenti.
3. Dopo la conferma scrive codice, schema e migrazione in un nuovo changeset.
4. Partono i controlli automatici. In caso di errore l'agente corregge.
5. Lo sviluppatore prova il catalogo sul sito di staging e chiede ritocchi in chat.
6. Propone il changeset per la release.
7. Il revisore esamina diff e controlli, poi clicca **"Approva e pubblica"**.
8. La release viene applicata in produzione: backup, schema, codice. Il catalogo è online.
9. In caso di problemi, rollback con un comando.

### 6.4 Gestione permessi

1. L'amministratore scrive in chat: "Il gruppo *traduttori* deve poter modificare solo le pagine inglesi, ma non pubblicarle".
2. L'agente traduce la richiesta in regole (ACL `g:traduttori:rlxw` su `/site/pages/en` con ereditarietà) e mostra l'effetto: chi guadagna o perde cosa.
3. L'amministratore conferma. La modifica è registrata nell'audit.

---

## 7. Requisiti non funzionali (visti dall'utente)

| ID | Requisito |
|---|---|
| NFR-01 | La prima release gira interamente **in locale con Docker**, con un solo comando di avvio, senza servizi cloud a parte l'API del modello AI. |
| NFR-02 | Nessuna dipendenza da servizi gestiti come Supabase: database, storage e git girano nei container. |
| NFR-03 | Una modifica di contenuto pubblicata è visibile sul sito entro pochi secondi. |
| NFR-04 | La verifica dei permessi è istantanea per l'utente (nessun ritardo percepibile). |
| NFR-05 | Nessuna perdita di dati in caso di release fallita: la release o si completa o non lascia traccia. |
| NFR-06 | L'interfaccia della chat è in italiano; il sistema deve supportare più lingue. |
| NFR-07 | Accessibilità del sito generato: le pagine prodotte devono rispettare WCAG 2.1 AA. |

---

## 8. Fuori ambito (prima release)

- Deploy in cloud o su più server (arriverà dopo l'ambiente locale).
- Editor visuale drag-and-drop.
- Pannello di amministrazione separato (per scelta, non per rinvio: vedi 5.11).
- Più siti gestiti dalla stessa istanza.
- Login con provider esterni (Google, SSO aziendale).
- E-commerce con pagamenti reali.
- App mobile.

---

## 9. Criteri di accettazione della prima release

1. Con `docker compose up` partono produzione e staging; il sito è una pagina bianca, valida come HTML.
    Root accede da `/_cms/login` e trova il widget su ogni pagina.
2. Un redattore crea e pubblica una pagina statica in produzione **solo dal widget**, senza aprire alcuna area di amministrazione.
3. Nessun utente, neanche root, **riesce** a modificare codice in produzione, e l'agente spiega perché.
4. Uno sviluppatore crea in staging una collezione e una pagina dinamica via chat; i controlli passano.
5. Un revisore approva con un clic; la pagina dinamica compare in produzione con i suoi dati.
6. Il rollback riporta la produzione alla release precedente.
7. *(fase 2)* Un autore in una cartella con sticky bit non riesce a eliminare la pagina di un altro autore.
8. *(fase 2)* Il comando "Perché?" spiega correttamente un permesso concesso e uno negato.
9. Ogni azione dei punti precedenti è presente nel registro di audit.
10. L'agente sviluppatore completa il punto 4 sia con un **abbonamento** (es. Claude Code)
    sia con una **chiave API** di un provider diverso, senza modifiche al resto del sistema.
11. Un visitatore non autenticato non scarica il widget.
12. Una pagina con due `<h1>` o senza `<title>` non si può pubblicare, e l'agente corregge l'errore.

---

## 10. Domande aperte

1. ~~Quanti revisori servono per una release?~~ **Deciso:** uno solo, approvazione con un clic.
2. I dati inseriti dai visitatori in produzione (es. form) devono essere copiati in staging, anonimizzati o mai?
3. Serve un flusso di approvazione anche per la pubblicazione dei contenuti (redattore → caporedattore)?
4. Quale budget massimo di spesa AI per utente o per mese?
