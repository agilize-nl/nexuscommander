# Functionaliteitsaudit NexusCommander — 10 september 2026

## Reikwijdte en bewijskracht

De gedeelde menu's, werkbalk, functietoetsenbalk, actiepalet, bestandslijst,
instellingen en de routering van desktop en web zijn op code gecontroleerd.
De correcties zijn getest door de echte TypeScript-handlers uit de Svelte-bron
uit te voeren met vervangende UI/IPC-afhankelijkheden. Dat controleert het
uitgevoerde gedrag en voorkomt dat een test alleen een tweede implementatie test.
Het is geen volledige interactieve kwalificatie van elke knop op elke desktop.

De werkboom was vooraf schoon. Gebruikersinstellingen zijn niet gewijzigd;
er is niet geïnstalleerd, gedeployed of gepubliceerd.

## Gevonden en hersteld

| Gebied | Oorzaak | Correctie |
|---|---|---|
| Ctrl+F3/F4/F5/F6 | Gewone functietoetscases onderschepten de sorteersneltoetsen; de sorteercode was onbereikbaar | Modifiers eerst verwerken; sorteren opent geen viewer, editor, kopieer- of verplaatsdialoog |
| Ctrl+F1/F2/F8 | Ontbrekende webroutering; Ctrl+F2 kon ook hernoemen en Ctrl+F8 verwijderen | Gedeelde shellroutering voor kort/volledig/boom |
| F1, F9, Ctrl+J | Ontbrekende desktopbindingen | Help en takenpaneel aangesloten |
| Alt+F7 | Werd als F7 verwerkt | Zoeken in plaats van map aanmaken |
| Alt+Shift+F9 | Werd als Alt+F9 verwerkt | Archief testen in plaats van uitpakken |
| Ctrl+Alt+Enter | Toonde eigenschappen terwijl contextmenu openen aankondigde | Expliciet openen via de shell; Alt+Enter blijft eigenschappen |
| Shift+F4 | Contextmenu kondigde terminal aan, keyboard opende editor | Terminal aangesloten |
| Ctrl+U | Dispatchte een event zonder ontvanger | Dezelfde shellactie als menu en palet |
| Ctrl+Shift+U | Had geen breedteherstel | Beide paneelverhoudingen terug naar 1:1 en opslaan |
| Boomweergave | Beide shells kozen altijd links | Actieve zijde bepaalt de boom |
| Sorteermenu | `ext` en `date` kwamen niet overeen met `extension` en `modified` | Kolomnamen vertaald vóór sorteren |
| Netwerk ontkoppelen | Geen handler voor menuactie | Opent verbindingenbeheer met ontkoppelknoppen per verbinding |
| Menu versus palet | Paneelwissel en doel=bron hadden aparte routering in MenuBar | Beide lopen door de shell |
| Ontbrekende desktoptools | Geschiedenis/synchronisatie zichtbaar zonder implementatie | Stubs verborgen; archief testen, splitsen en samenvoegen nu volledig geïmplementeerd in desktopbackend |
| Lege lijst + F3/F4 | Ongeldige entry direct aangesproken | Geen actie zonder bestand |
| Shift+pijlen | Geen selectie | Selectie van de verlaten rij in NC-stijl |
| Letterzoeken a/f/m | Losse cases onderschepten gewone letters | Alle letters bereiken letterzoeken; Ctrl-combinaties behouden |
| PageUp/PageDown/End | Negatieve indices/paginagrootte mogelijk bij lege/kleine lijst | Grenzen minimaal nul, paginagrootte minimaal één |
| Filteren + uitpakken/slepen | Index uit zichtbare lijst toegepast op ongefilterde lijst | Zichtbare entry gebruiken; ouderregel niet sleepbaar |
| Bovenliggende map | Cursorherstel gebruikte ongefilterde index | Zichtbare lijst gebruiken |
| ZIP kopiëren/slepen op desktop | Extensie alleen maakte een gewoon archief tot een virtueel archieflid | Alleen paden met een interne component laten uitpakken |
| Knippen/plakken | Geen read-onlycontrole en verworpen IPC-promises niet opgevangen | Archieven beschermen, fout tonen, beide panelen ook na gedeeltelijke uitvoering verversen |
| Modaliteit | Desktopactiepad en globale sneltoetsen konden achter overlays doorgaan | Overlays/tekstvelden beschermen; taken blijven bereikbaar |
| Help in Opties | Overlayfilter blokkeerde de eigen Help-knop | Gerichte uitzondering voor Opties-help |
| Webinstellingen maphaakjes/ouderregel | Dialoog schreef desktopveldnamen; weergave las webveldnamen | Shell geeft de juiste instellingenvelden aan de gedeelde dialoog |
| Uploadcontextmenu | Ook desktop toonde een niet-aangesloten uploadactie | Alleen tonen wanneer de shell upload ondersteunt |
| Foutmeldingen | Terminal/vergelijking en enkele desktopacties faalden alleen in de console | Foutmelding in het actieve paneel |
| Helpteksten | F2/F9/F10, afsluiten en enkele hints verouderd | Huidige bindingen gedocumenteerd |

## Overzicht van opties en actiepaden

Deze tabel onderscheidt routering van uitvoering door het besturingssysteem.
“Bestaand pad” betekent dat een implementatie is aangetroffen, niet dat elke
platform- of bestandsvariant interactief is getest.

| Opties | Pad / beoordeling |
|---|---|
| Bekijken F3, bewerken F4 | Actief bestand → shellviewer/editor; lege lijst afgevangen |
| Kopiëren F5, verplaatsen F6, map F7, verwijderen F8/Delete | Gedeelde dialoog → afzonderlijke backend; gewone toetsen behouden in regressietests |
| Hernoemen F2, multi-rename Ctrl+M | Inline rename respectievelijk batchdialoog; bestaande backendresultaten |
| Inpakken Alt+F5, uitpakken Alt+F9 | Gedeelde dialoog → archive-IPC; filter- en ZIP-kopieerfouten hersteld |
| Archief testen, splitsen, samenvoegen | Web en desktop; desktopbackend geïmplementeerd via transactionele staging (`Staged`) |
| Ruimte berekenen Space, alles Alt+Shift+Enter | Bestaande grootteberekening; Space selecteert tevens en verplaatst de cursor |
| Alles selecteren/deselecteren Ctrl+Num +/- | Actieve lijst; Num +/- zonder Ctrl opent patroonselectie |
| Alleen bestanden selecteren/deselecteren | `selectAllFiles` / `unselectAllFiles` |
| Groep selecteren/deselecteren | Patroondialoog → `handleSelectGroup` / `handleUnselectGroup` |
| Omkeren Num *, selectie herstellen | `invertSelection` / `handleRestoreSelection` |
| Zelfde extensie Alt+Num +/- | `selectSameExtension` / `unselectSameExtension` |
| Vergelijken Shift+F2 | Shell → `compareDirectories` → selecties in beide panelen |
| Zoeken Alt+F7 | Zoekdialoog; eigen achtergrondzoekpad |
| Favorieten Ctrl+D | HotlistModal; bestaande bookmark-IPC |
| Wisselen Ctrl+U, doel=bron | Shellroutering; navigatie/padstores |
| Paneelbreedten Ctrl+Shift+U | `equalizePanels`, inclusief opslaan verhouding |
| Taken F9/Ctrl+J, takenmenu | Wisselen respectievelijk openen van TaskProgress |
| Terminal Shift+F4 | Backendlauncher; fouten zichtbaar, lokale terminal hangt af van installatie |
| Netwerk verbinden/ontkoppelen | Verbindingendialoog; daadwerkelijke mounts vereisen bereikbare server/rechten |
| Kort Ctrl+F1, volledig Ctrl+F2 | Actieve lijst en instellingen |
| Enkel/dubbel paneel, horizontaal/verticaal | TwinPanels met bestaande persistencelaag |
| Boom Ctrl+F8, snelvoorbeeld Ctrl+Q | Actieve boom respectievelijk voorbeeld in andere paneel |
| Sorteren naam/extensie/datum/grootte | Gecorrigeerde kolomnamen en Ctrl+F3 t/m F6 |
| Opties | Taal, thema, selectiegedrag, audiokeuze, lettertypen, weergavevinkjes en kolommen via config; webveldcorrectie voor twee vinkjes |
| Opgeslagen kolomweergaven / iconenthema's | Desktopmogelijkheden via bestaande props; geen instellingenbestanden gewijzigd |
| Help F1, sneltoetsen, ondersteuning, Over | Shell opent overeenkomstig help/infovenster; Opties-help toegestaan |
| Upload bestanden/map | Webbestandskiezer en bestaande uploader; desktopcontextmenu toont dit niet |
| Administrator, afsluiten | Desktopmogelijkheden; geen privileges of exit automatisch uitgevoerd tijdens audit |
| Werkbalk vernieuwen/home/omhoog/menu/weergave/favorieten/opties | Uniforme `nc:menu-action`-routering |
| Actiepalet F10/F12/Ctrl+P | Sluit eerst en dispatcht vervolgens dezelfde acties |
| Tab, pijlen, Home/End, PageUp/PageDown, Insert/Space | Actieve lijst; indexgrenzen en Shift-selectie hersteld |
| Alt+links/rechts, Backspace, Enter, Alt+Enter | Historie, oudermap, openen en eigenschappen via bestaande functies |
| Ctrl+C/X/V | App-klembord; foutafhandeling en read-onlycontrole toegevoegd |
| Tabs nieuw/sluiten/dupliceren/hernoemen/vergrendelen/overige sluiten | Bestaande FileList- en FolderTabs-handlers; Ctrl+T/W blijven behouden |
| Contextmenu bestandsacties/openen-met/eigenschappen | Bestaande callbacks; terminalhint en uploadbeschikbaarheid gecorrigeerd; diverse systeemeigen opties en XDG/GIO-appdetectie voor web en desktop |

## Verificatie

- Eerste regressieset: tegen HEAD **33 fouten van 43 tests**; dezelfde set met correcties **43/43 geslaagd**.
- Uitgebreide set: **74/74 UI-tests geslaagd**, via `npm run test:ui`; inclusief open-with tests toegevoegd aan `npm run verify`.
- `npm run check`: nul Svelte-fouten en waarschuwingen; locales en alle statische gates slagen.
- `npm run build`: desktopfrontend en webfrontend bouwen.
- Webbackend: **149 geslaagd, 3 bestaande skips, 0 fouten**.
- Rust: **169 geslaagd, 0 fouten**.

## Grenzen en vervolgvalidatie

Geen interactieve Linux/Windows/macOS-acceptatietest uitgevoerd. Externe
editors/terminals, netwerkshares, privilegeverhoging, echte conflict-/annuleer-
dialogen, uiteenlopende archiefinhoud en apparaatgebonden sneltoetsen zijn
niet end-to-end bewezen. De backend heeft inmiddels een volledige desktopimplementatie voor
archief testen, splitsen en samenvoegen gekregen via `src-tauri/src/archive.rs`
en transactionele staging (`crate::engine::commit::Staged`), met actieve
beschikbaarheid in `desktopIpc` en unit-testverificatie (zie ook `docs/OPENEN_MET_SYSTEEMEIGEN_OPTIES_IMPLEMENTATIE_2026-09-10.md` voor de open-with integratie). Archiefnavigatie/preview van interne paden verdient
aparte integratietests: de desktopreader levert een vlakke lijst en ondersteunt
niet automatisch dezelfde virtuele padsemantiek als de webbackend.

De bestaande veiligheidsroadmap blijft van toepassing; deze audit vervangt
geen volledige bestandsintegriteits- of platformkwalificatie.
