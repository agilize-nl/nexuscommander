# Transfer-wachtrij (Double Commander-stijl) — implementatieplan

**Datum:** 2026-09-16
**Status:** herzien ontwerp, nog niet geïmplementeerd
**Scope:** `packages/ui` en de integratiepunten in `apps/desktop` en `apps/web`

## Doel

Bij F5/F6/F8 kan de gebruiker de al geopende copy-, move- of delete-dialoog
bevestigen zoals nu, of de operatie eerst aan een sessiegebonden wachtrij
toevoegen. De wachtrij is een planningslaag: bestanden worden pas gewijzigd
wanneer de gebruiker **Uitvoeren** kiest.

Dit is nadrukkelijk geen tweede bestandsexecutor. Uitvoering blijft via de
bestaande `taskCreate()`/`taskExecute()`-contracten en dus via de bestaande
task-implementatie in elke shell lopen. Bestaande directe F5/F6/F8-,
clipboard- en drag-and-drop-paden blijven onveranderd.

## Gevalideerde uitgangspunten

- `TaskQueueManager` in de desktop-app is een uitvoerings-/concurrencylaag;
  `task_create` maakt een taak en `task_execute` start die asynchroon.
  De web-route start eveneens asynchroon. Een `await taskExecute(...)` wacht
  dus **niet** op het einde van een transfer.
- De bestaande shells hebben hun eigen task-lifecycle-hulpen
  (`startBackgroundTask()` op desktop en `runTrackedTask()` op web). Die
  openen `TaskProgress`, rapporteren snelle fouten en verversen beide panelen
  wanneer een taak terminaal is. De wachtrij moet diezelfde lifecycle per
  shell hergebruiken. Splits daarvoor op desktop zo nodig de bestaande helper
  in `createTask(...)` en `startTrackedTask(taskId)`; een gedeelde util mag
  niet zelf een tweede, afwijkende error- of refresh-flow maken.
- F2 is in `FileList.svelte` de bestaande inline-rename-sneltoets. Beide
  `FileList`-instanties luisteren op `window`, maar stoppen al wanneer
  `isOverlayActive` waar is. Een open `Dialog` maakt die overlay actief. De
  F2-actie van de wachtrij moet daarom in de modale dialoog worden afgehandeld,
  `preventDefault()` gebruiken en de bestaande overlay-garantie behouden; niet
  vertrouwen op focus of alleen `stopPropagation()` (listeners op hetzelfde
  `window`-target kunnen dat nog steeds ontvangen).
- `ConflictPolicy` en `OperationSpec` bestaan als engine-/wire-types, maar
  `taskCreate()` accepteert vandaag alleen `taskType`, `sources` en `target`.
  De instellingen in de copy/move-dialoog worden ook niet als taak-spec aan
  deze executor doorgegeven. Een wachtrijregel mag daarom geen instelbaar of
  "effectief" conflictbeleid tonen totdat beide backends dat werkelijk
  ondersteunen. Conflicten blijven de bestaande `WaitingForInput`-dialoog in
  `TaskProgress` gebruiken.
- Een delete-taak encodeert zijn betekenis in `target`: `"trash"` of
  `"permanent"`. `destination: null` alleen is dus onvoldoende: de wachtrij
  moet de delete-modus exact bewaren.
- Een F5 vanuit een archiefpad (`::`) is een extractie-pad. De desktop-shell
  behandelt dat nu via `archiveUnpack()` in plaats van via `taskCreate()`.
  Dit kan niet als gewone copy-regel worden ingepland zonder gedragsverlies.

## Gebruikersflow

1. De gebruiker opent met F5, F6 of F8 de bestaande dialoog. Bronselectie,
   doelveld, opties en de directe bevestigingsknop blijven identiek aan de
   huidige flow.
2. Voor gewone copy/move en delete toont de dialoog aanvullend **F2 — Toevoegen
   aan wachtrij**. Klikken of F2 voegt een momentopname van de actuele invoer
   toe en sluit de dialoog zonder een taak aan te maken.
3. Voor een copy uit een archief is deze actie niet beschikbaar. De bestaande
   directe extractie blijft dan de enige F5-flow in v1. De reden wordt in de
   UI kort toegelicht.
4. Een badge naast de bestaande task-manager-toegang is zichtbaar zodra de
   wachtrij regels bevat. Deze opent het wachtrijvenster. Er komt geen globale
   F2- of andere nieuwe sneltoets; buiten de dialoog blijft F2 rename.
5. In het wachtrijvenster kan de gebruiker regels verwijderen, hun volgorde
   wijzigen en het doel van copy/move aanpassen. Bij een delete-regel is alleen
   de duidelijk gelabelde modus `Prullenbak` of `Permanent verwijderen`
   zichtbaar; die is in v1 niet achteraf wijzigbaar.
6. **Uitvoeren** verwerkt regels strikt in de getoonde volgorde, één tegelijk.
   Zo blijft herordenen betekenisvol en blijven afhankelijke operaties (zoals
   eerst kopiëren, dan verplaatsen) correct. `TaskProgress.svelte` blijft de
   voortgang en eventuele conflictsituaties tonen.
7. Na een geslaagde regel verdwijnt alleen die regel. Bij een mislukte,
   geannuleerde of niet-aanmaakbare taak stopt de run en blijven die regel en
   alle volgende regels staan voor inspectie, herordening of een latere retry.
   De gebruiker ziet de bestaande foutmelding. Een conflict is niet terminaal:
   de run wacht totdat de bestaande conflict-dialoog de taak hervat en gaat dan
   pas verder.
8. Een run met één of meer permanente deletes vraagt vlak vóór de eerste taak
   nogmaals een expliciete bevestiging, met het aantal betrokken regels. Dat
   voorkomt dat een eerder opgebouwde wachtrij onopvallend een onherstelbare
   actie uitvoert.

## Architectuur

### 1. Gedeelde, niet-persistente store

Voeg in `packages/ui/src/lib/stores.ts` een store toe. Gebruik een
gediscrimineerde vorm zodat de delete-modus niet kan verdwijnen:

```ts
export type QueuedOperation =
  | {
      id: string;
      kind: "copy" | "move";
      sources: string[];
      target: string;
      label: string;
    }
  | {
      id: string;
      kind: "delete";
      sources: string[];
      target: "trash" | "permanent";
      label: string;
    };

export const transferQueue = writable<QueuedOperation[]>([]);
export const transferQueueOpen = writable(false);
export const transferQueueRunningId = writable<string | null>(null);
```

Gebruik `crypto.randomUUID()` met een kleine, testbare fallback voor omgevingen
waar dat niet beschikbaar is. De store wordt niet in localStorage of Tauri
Store opgeslagen: de wachtrij vervalt bij herstart.

Sla alleen het bestaande taakcontract op. Voeg in v1 geen
`ConflictPolicy`, `OperationSpec`, metadata-, symlink- of verificatievelden
toe: die zouden suggereren dat instellingen worden afgedwongen terwijl de
huidige task API ze niet ontvangt.

### 2. `TransferQueue.svelte`

Nieuw gedeeld component in `packages/ui/src/lib/components/`:

- lijst met soort, aantal bronnen, ingekort bronoverzicht, doel of delete-modus;
- bewerkbaar doel uitsluitend voor copy/move, met validatie op een niet-lege
  getrimde waarde voordat de run mag starten;
- verwijder- en omhoog/omlaag-knoppen; geen drag-and-drop nodig in v1;
- **Uitvoeren**, **Wis alles** en **Sluiten**. Tijdens een run zijn wijzigen,
  wissen en opnieuw uitvoeren uitgeschakeld; sluiten mag wel, zonder de run te
  annuleren;
- toegankelijke modale semantiek, focusbeheer en Escape-gedrag volgens de
  bestaande dialogen; het venster moet worden opgenomen in `anyOverlayOpen` /
  `isOverlayActive` van beide shells;
- uitsluitend `--color-nc-*`-variabelen en Svelte-5-runes.

De component ontvangt callbacks van de shell (`onexecute`, `onconfirmPermanent`
of gelijkwaardig), zodat shell-specifieke task-lifecycle, meldingen en
panelfreshes niet naar `packages/ui` lekken.

### 3. Dialoog-integratie zonder F2-regressie

Breid `Dialog.svelte` uit met een optionele `onqueue`-callback en een
`queueAvailable`-prop. `Dialog` bouwt geen taken en importeert geen
shell-logica; hij geeft uitsluitend de actuele dialoogwaarde door.

- De F2-handler wordt toegevoegd aan de al bestaande modale
  `<svelte:window onkeydown=...>`-handler, alleen voor `copy`, `move` en
  `delete` wanneer `queueAvailable` waar is. Hij roept `preventDefault()` en
  `stopImmediatePropagation()` aan, waarna hij `onqueue(...)` aanroept.
- Voor copy/move is een leeg, getrimd doel ongeldig, precies zoals directe
  bevestiging. Voor delete wordt de op dat moment gekozen `trash`/`permanent`-
  modus doorgegeven.
- De zichtbare F2-knop gebruikt exact dezelfde helper als de key-handler.
- De shells bepalen `queueAvailable`: `false` voor archive-sources en `true`
  voor normale copy/move/delete. Directe bevestiging en de bestaande
  `handleDialogConfirm()` blijven verder ongewijzigd.

De shell zet bij `onqueue` een immutable snapshot van `dlgType`,
`dlgSourcePaths` en de gevalideerde waarde in de store en roept daarna
`closeDialog()` aan. Dit voorkomt dat een later gewijzigde dialoog of selectie
een reeds ingeplande regel beïnvloedt.

### 4. Uitvoeren: serialisatie boven de bestaande task API

Elke shell implementeert één kleine queue-runner naast zijn bestaande
task-hulpen. Refactor de desktop-helper eerst zodat zowel de directe flow als
de runner dezelfde `startTrackedTask(taskId)` kunnen gebruiken; de web-runner
kan de bestaande `runTrackedTask(taskId)` gebruiken:

```ts
for (const operation of snapshotInDisplayedOrder) {
  transferQueueRunningId.set(operation.id);
  const taskId = await taskCreate(operation.kind, operation.sources, operation.target);
  startAndTrackUsingTheExistingShellLifecycle(taskId);
  const terminalTask = await waitForTerminalTask(taskId); // taskGet-polling

  if (terminalTask.status !== "Completed") break;
  removeOnly(operation.id);
}
transferQueueRunningId.set(null);
```

`startAndTrackUsingTheExistingShellLifecycle` moet bij beide shells meteen
`taskProgress.notifyTaskStarted()` doen, snelle foutstatussen tonen en de
bestaande terminale refresh laten lopen. `waitForTerminalTask()` pollt
`taskGet()` totdat de taak `Completed`, `Failed` of `Cancelled` is. Bij
`WaitingForInput` of `Paused` wacht hij door. Netwerk-/IPC-fouten bij create,
execute of polling stoppen de run en laten de regel intact.

De runner mag niet de hele wachtrij na het submitten legen en mag taken niet
parallel `taskExecute()`-en. De huidige backend-start is asynchroon; parallel
submitten zou de getoonde volgorde onbetrouwbaar maken, en de web-backend heeft
geen gelijkwaardige desktop-scheduler als volgordegarantie.

### 5. Shell-integratie

In beide `+page.svelte`-bestanden:

- render `TransferQueue` conditioneel op `$transferQueueOpen`;
- neem die conditie op in `anyOverlayOpen` zodat paneeltoetsen niet achter het
  venster werken;
- koppel de badge aan de bestaande task-managerzone, maar maak hem een eigen
  knop met label/a11y-tekst; een klik opent alleen de wachtrij;
- houd de bestaande directe task handlers, archive-extractie en
  `TaskProgress`-integratie intact;
- laat de runner de bestaande task tracking gebruiken en dupliceer geen
  polling die dezelfde taak opnieuw zou starten.

Er zijn geen nieuwe Rust-commands, Express-routes of wijzigingen aan
`check-ipc-parity.js` nodig voor v1.

## Buiten scope voor v1

- Persistente wachtrijen, geplande uitvoering en taakgeschiedenis.
- Preflight-conflictscans of een nieuw task-contract voor per-regel
  conflict-/metadata-/symlink-/verificatiebeleid.
- Archiefextracties in de wachtrij. Dat vereist een apart, expliciet
  extractie-queue-item met dezelfde rapportage- en conflictsemantiek als
  `archiveUnpack()`.
- Wijzigingen aan de engine, `CommitOutcome`/`Journal`, directe VFS-commands,
  clipboard of drag-and-drop.

## Implementatiestappen

1. Voeg de gediscrimineerde queue-types en stores toe, plus kleine zuivere
   helpers voor toevoegen, wijzigen, verwijderen en herordenen.
2. Voeg i18n-sleutels toe aan alle zes localebestanden (`en`, `de`, `es`, `fr`,
   `nl`, `pt`), waaronder de archive-onbeschikbaarheid en de finale waarschuwing
   voor permanente deletes. Nederlands gebruikt formeel "u".
3. Breid `Dialog.svelte` uit met de optionele queue-callback, de F2-guard en
   de knop. Verifieer zowel normale als archief-copy-dialoog.
4. Bouw `TransferQueue.svelte` met edit/remove/reorder, uitvoer-lock en
   toegankelijke modaliteit.
5. Integreer badge, overlaystatus, dialoogcallback en de seriële runner in
   eerst één shell en daarna identiek in de andere, met behoud van de eigen
   lifecycle-hulpen.
6. Test minimaal:
   - F2 buiten een dialoog blijft inline rename; F2 in een open dialoog maakt
     geen rename of paneelactie.
   - Normale copy, move, trash-delete en permanente delete behouden exact hun
     bronnen, doel/modus en volgorde.
   - F2 is niet beschikbaar voor archive-copy; directe extractie werkt nog.
   - Een conflict pauzeert de runner; na oplossen gaat alleen de volgende regel
     verder.
   - Een mislukte/geannuleerde regel laat zichzelf en volgende regels staan;
     een geslaagde regel verdwijnt en beide panelen verversen.
   - Reorder bepaalt de feitelijke startvolgorde; dubbele klik op Uitvoeren
     start geen tweede run.
7. Draai `npm run check`, de bestaande web-servertests (`npm run test
   --workspace apps/web`) en daarna `npm run verify`. Er is momenteel geen
   Playwright-configuratie in `apps/web`; voeg dus niet een niet-bestaande
   Playwright-gate aan dit plan toe. Handmatige UI-verificatie of later gekozen
   e2e-infrastructuur vult de bovenstaande interacties aan.

## Bronnen

- `packages/ui/src/lib/{stores,ipc-contract,ipc-registry}.ts`
- `packages/ui/src/lib/components/{Dialog,FileList,TaskProgress}.svelte`
- `apps/{desktop,web}/src/routes/+page.svelte`
- `apps/desktop/src-tauri/src/{lib,task_queue}.rs`
- `apps/web/server/routes/tasks.js`
- `docs/COMPREHENSIVE_QUALITY_SAFETY_UPGRADE_PLAN_2026-07-28.md`
