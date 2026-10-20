# NexusCommander — i18n Unificatie-analyse (Desktop vs. Web)

**Datum:** 2026-07-23
**Scope:** `apps/desktop/src/lib/locales/en.json` (242 leaf-keys) vs. `apps/web/server/langs/en.json` (401 leaf-keys), met steekproef op `nl` en `de`.
**Doel:** de ware aard van de flat-key-divergentie (~370 web-only / ~211 desktop-only) vaststellen vóór de i18n-consolidatie in Fase 5 van het monorepo-migratieplan (`apps/desktop/docs/NEXUS_MIGRATIEPLAN_MONOREPO_2026-07-23.md`).

---

## TL;DR

- **54 sleutels zijn 1-op-1 hernoemd/verplaatst** (identieke Engelse tekst, ander pad) — ondubbelzinnig te matchen.
- **40 desktop- + 60 web-sleutels** delen generieke, herbruikte UI-tekst ("Cancel", "OK", "Copy", …) over **27 clusters** — geen 1-op-1 rename, wel dezelfde tekst op meerdere plekken aan beide kanten.
- **117 sleutels zijn écht alleen-op-desktop** (functionaliteit/tekst die web niet heeft), waarvan ~22 eigenlijk near-renames zijn met een ingebakken sneltoets-suffix (bv. `"Copy (F5)"` vs. web's tegenhanger `"Copy"`) — netto nieuw is dus eerder ~95.
- **256 sleutels zijn écht alleen-op-web** (functionaliteit/tekst die desktop niet heeft) — grotendeels hele web-only features: `upload.*`, `network.*`, `multi_rename.*`, `help_topics.*`/`help_viewer.*`, `folder_tabs.*`, uitgebreide `file_properties.*`.
- Van de **31 sleutelpaden die letterlijk hetzelfde pad hebben** aan beide kanten, hebben **9 een afwijkende Engelse waarde** (conflict) en 22 een identieke waarde.
- **nl/de (en fr/es/pt) steekproef:** binnen elke kant is het sleutel-schema 100% identiek aan het Engelse schema van diezelfde kant (0 ontbrekend, 0 extra, voor alle 5 talen). De divergentie zit dus uitsluitend tussen desktop-schema en web-schema, niet tussen talen.
- **Belangrijkste conclusie voor de aanpak:** dit is grotendeels een **structuur-/hernoem-vraagstuk, geen vertaalvraagstuk** — beide bomen zijn al volledig vertaald in alle 6 talen voor hún eigen sleutels. Een superset-merge vereist in principe **0 nieuwe vertalingen**, wel een mechanische key-mapping- en call-site-update-klus.

---

## 1. Methodologie

1. Beide `en.json`-bestanden zijn geflattened naar dot-paths (`menu.files.label` etc.).
2. Sleutelpaden zijn vergeleken op **exacte pad-match** → "shared paths" (31).
3. Voor paden die alleen aan één kant bestaan, is de **waarde** (case-insensitive, whitespace-genormaliseerd, getrimd) vergeleken met de waarden van de unieke paden aan de andere kant:
   - Is er precies één desktop-only pad én precies één web-only pad met identieke waarde → **hoge-zekerheid rename** (1-op-1, opgenomen in de mapping-tabel).
   - Heeft de waarde meerdere kandidaten aan één of beide kanten (bv. "Cancel" komt op desktop op 2 plekken en op web op 4 plekken voor) → **ambigue cluster**: wél dezelfde tekst, geen eenduidige 1-op-1 rename te reconstrueren.
   - Geen enkele waarde-match aan de andere kant → **genuinely-only** (b)/(c).
4. Voor de 31 gedeelde paden is gecontroleerd of de waarde (genormaliseerd) gelijk is; zo niet → **conflict**.
5. Voor `nl`/`de` (plus `fr`/`es`/`pt` als extra check) is per kant het sleutel-schema (alle paden) vergeleken met het schema van de eigen `en.json` — dit toetst alleen structuur/volledigheid, niet vertaalkwaliteit; een handmatige steekproef van een paar waarden bevestigt echte (niet-Engelse) vertalingen.

---

## 2. Classificatie (a)/(b)/(c) — cijfers

| Categorie | Aantal | Toelichting |
|---|---|---|
| Gedeeld pad, identieke waarde | 22 | Geen actie nodig |
| Gedeeld pad, **conflicterende** waarde | 9 | Zie §4 — keuze nodig |
| **(a) Hoge-zekerheid renames** (1-op-1) | 54 paar (108 sleutels) | Zie §3 — mapping-tabel |
| **(a) Ambigue generieke-tekst clusters** | 27 clusters (40 desktop + 60 web sleutels) | Zie §3.2 — geen 1-op-1 te maken |
| **(b) Genuinely desktop-only** | 117 | Zie §5 |
| **(c) Genuinely web-only** | 256 | Zie §6 |
| **Totaal desktop EN leaf-keys** | 242 | 31 + 54 + 40 + 117 = 242 ✓ |
| **Totaal web EN leaf-keys** | 401 | 31 + 54 + 60 + 256 = 401 ✓ |

Dit klopt met de ruwe flat-key-vergelijking uit de opdracht (~370 web-only / ~211 desktop-only vóór dedup): desktop-only vóór dedup = 211 (54 + 40 + 117), web-only vóór dedup = 370 (54 + 60 + 256).

**Interpretatie:** van de 211 "desktop-only" en 370 "web-only" sleutels uit de naïeve flat-vergelijking is **94 aan desktop-kant (54+40) en 114 aan web-kant (54+60) in werkelijkheid dezelfde tekst onder een ander pad** — geen nieuwe content, maar structuur-drift. Het echte, netto-unieke verschil is kleiner dan de ruwe telling suggereert, maar de **meerderheid van de divergentie (117 + 256 = 373 sleutels) is wél degelijk verschillende content** — vooral doordat web een aantal complete features heeft die desktop niet heeft (en vice versa, zij het in mindere mate).

---

## 3. (a) Renames / restructures

### 3.1 Hoge-zekerheid 1-op-1 mapping (desktop ↔ web)

54 paren waarbij de Engelse tekst **exact** (case-insensitive) overeenkomt en er aan beide kanten precies één kandidaat-sleutel was — dit zijn vrijwel zeker dezelfde tekst-string die tijdens de twee onafhankelijke ontwikkeltrajecten onder een ander pad terecht is gekomen.

| Desktop key | Web key | Waarde (EN) |
|---|---|---|
| `about.github` | `about.view_github` | View on GitHub |
| `dialog.ask` | `drop_menu.ask` | Ask |
| `dialog.combine_prompt` | `dialogs.combine_into` | Combine selected files into: |
| `dialog.delete_prompt` | `dialogs.delete_confirm` | Are you sure you want to delete {n} items? |
| `dialog.more_items` | `drop_menu.and_more` | ...and {n} more |
| `dialog.pack_running` | `tasks.running` | Running |
| `dialog.properties_title` | `file_properties.tab_properties` | Properties |
| `dialog.reserve_space` | `drop_menu.reserve_space` | Reserve space |
| `dialog.select_wildcard` | `dialogs.select_pattern` | Enter wildcard pattern (e.g. *.txt, data_*): |
| `dialog.split_prompt` | `dialogs.split_into` | Split file into chunks of size: |
| `dialog.split_unit` | `size_units.bytes` | Bytes |
| `dialog.unpack_to` | `dialogs.unpack_to` | Unpack archive to: |
| `drop_menu.copy_datetime` | `drop_menu.copy_date_time` | Copy date/time |
| `drop_menu.import_title` | `drop_menu.title_import` | Import Files |
| `drop_menu.save_as_default` | `drop_menu.save_default` | Save these options as default |
| `drop_menu.transfer_title` | `drop_menu.title_transfer` | Transfer Files |
| `drop_menu.verify_after_write` | `drop_menu.verify` | Verify after write |
| `file_properties.file_suffix` | `file_properties.file` | File |
| `filelist.f10` | `menu.exit` | Exit |
| `filelist.f7` | `fkeys.f7` | MkDir |
| `filelist.path_cut` | `common.cut` | Cut |
| `filelist.path_paste` | `common.paste` | Paste |
| `filelist.path_select_all` | `menu.select_all` | Select All |
| `filelist.refresh` | `common.refresh` | Refresh |
| `menu.commands.label` | `menu.commands` | Commands |
| `menu.commands.swap_panels` | `menu.swap_panels` | Swap Panels |
| `menu.commands.target_equals_source` | `menu.target_source` | Target = Source |
| `menu.configuration.options` | `menu.options` | Options... |
| `menu.files.calculate_space` | `menu.calc_space` | Calculate Space |
| `menu.files.label` | `menu.files` | Files |
| `menu.files.test_archive` | `menu.test_archive` | Test Archive |
| `menu.help.label` | `menu.help` | Help |
| `menu.selection.select_same_ext` | `menu.select_same_ext` | Select Same Extension |
| `menu.selection.unselect_same_ext` | `menu.unselect_same_ext` | Unselect Same Extension |
| `options.appearance.dark_themes` | `options.dark_themes` | Dark Themes |
| `options.appearance.font_tab` | `options.font_tab` | Folder Tabs Font |
| `options.appearance.light_themes` | `options.light_themes` | Light Themes |
| `options.buttons.new` | `options.new` | New |
| `options.buttons.save` | `common.save` | Save |
| `options.categories.appearance` | `options.appearance` | Appearance |
| `options.categories.general` | `options.general` | General |
| `options.categories.interface` | `options.interface` | Interface |
| `options.columns.table_header_align` | `options.align` | Align |
| `options.columns.table_header_caption` | `options.caption` | Caption |
| `options.columns.table_header_contents` | `options.field_contents` | Field contents |
| `options.columns.table_header_width` | `options.width` | Width |
| `options.interface.show_brackets` | `menu.show_folder_brackets` | Folders with brackets [] |
| `options.interface.show_tabs` | `options.show_tabs` | Show folder tabs |
| `search.label_content` | `search.find_text` | Find text (optional): |
| `search.label_query` | `search.search_for` | Search for (name/pattern): |
| `search.label_start` | `search.start_from` | Start from: |
| `search.placeholder_query` | `search.placeholder_pattern` | e.g. *.rs or config |
| `search.start_btn` | `search.start_search` | Start Search |
| `toolbar.toggle_menu` | `menu.toggle_menu_bar` | Toggle Menu Bar |

### 3.2 Ambigue clusters — gedeelde generieke tekst, geen eenduidig 1-op-1-pad

Voor deze waarden bestaan **meerdere** kandidaat-sleutels aan minstens één kant, dus een automatische 1-op-1-koppeling zou willekeurig zijn. Het gaat om generiek hergebruikte UI-woorden (knoppen/labels) die op verschillende plekken in de UI voorkomen. Voor de unificatie is de vraag per cluster: mag dit één canonieke sleutel worden (bv. één `common.cancel`), of moeten sommige varianten om functionele redenen apart blijven (bv. een toekomstige taal kan "Cancel" in een upload-context anders willen vertalen dan in een dialoogvenster)?

| Waarde (EN) | Desktop keys | Web keys |
|---|---|---|
| close | `about.close` | `common.close`, `dialogs.close` |
| cancel | `dialog.cancel`, `options.buttons.cancel` | `common.cancel`, `dialogs.cancel`, `drop_menu.cancel`, `tasks.cancel` |
| combine files | `dialog.combine_title`, `menu.files.combine` | `menu.combine_files` |
| copy | `dialog.copy_title`, `filelist.f5`, `filelist.path_copy` | `common.copy`, `fkeys.f5`, `menu.copy` |
| delete | `dialog.delete_title`, `filelist.f8`, `options.buttons.delete` | `common.delete`, `fkeys.f8`, `menu.delete` |
| error | `dialog.error` | `common.error`, `tasks.error` |
| move | `dialog.move_title`, `filelist.f6` | `fkeys.f6` |
| ok | `dialog.ok`, `options.buttons.ok` | `common.ok`, `dialogs.ok` |
| options | `dialog.options_btn`, `menu.configuration.label`, `toolbar.options` | `dialogs.options`, `drop_menu.options`, `menu.configuration` |
| overwrite | `dialog.overwrite` | `drop_menu.overwrite`, `tasks.overwrite`, `upload.overwrite` |
| rename | `dialog.rename`, `dialog.rename_title`, `options.buttons.rename` | `drop_menu.rename`, `fkeys.f2`, `upload.rename` |
| select group | `dialog.select_group_title` | `dialogs.select_group`, `menu.select_group` |
| skip | `dialog.skip` | `drop_menu.skip`, `tasks.skip`, `upload.skip` |
| split file | `dialog.split_title`, `menu.files.split` | `menu.split_file` |
| unselect group | `dialog.unselect_group_title` | `dialogs.unselect_group`, `menu.unselect_group` |
| extract files | `drop_menu.extract_title` | `dialogs.extract_title`, `drop_menu.title_extract` |
| attr | `filelist.attr` | `common.attr`, `panel.attr` |
| date | `filelist.date` | `common.date`, `panel.date` |
| ext | `filelist.ext` | `common.ext`, `panel.ext` |
| view | `filelist.f3` | `fkeys.f3`, `menu.view` |
| edit | `filelist.f4` | `fkeys.f4`, `hotlist.edit`, `menu.edit` |
| name | `filelist.name` | `common.name`, `panel.name` |
| size | `filelist.size` | `common.size`, `panel.size` |
| keyboard shortcuts | `menu.help.keyboard` | `help_topics.shortcuts`, `menu.help_shortcuts` |
| apply | `options.buttons.apply` | `common.apply`, `dialogs.apply` |
| custom columns | `options.categories.columns` | `help_topics.columns`, `options.custom_columns` |
| actions | `options.columns.table_header_actions` | `fkeys.f10`, `options.actions` |

---

## 4. Conflicterende waarden op gedeelde sleutelpaden

Van de 31 paden die letterlijk identiek zijn aan beide kanten, hebben **9** een afwijkende Engelse tekst. Dit zijn de enige plekken waar unificatie een **inhoudelijke keuze** vergt (niet slechts een padkeuze):

| Key | Desktop (EN) | Web (EN) | Aard van het verschil |
|---|---|---|---|
| `actions.no_results` | No results found | No actions found | Inhoudelijk verschil — de desktop-tekst is generieker ("results"), de web-tekst is specifieker ("actions"). Kies er één; beide zijn correct Engels, geen typfout. |
| `drop_menu.items_to` | {n} item(s) to: | {n} item{s} to: | Pluralisatie-bug in de web-string (`item{s}` i.p.v. `item(s)`) — waarschijnlijk een kapotte i18n-interpolatie-poging. Desktop's vorm overnemen. |
| `drop_menu.when_cannot_set_property` | When cannot set property | When cannot set property: | Alleen leesteken (dubbele punt) verschil. |
| `file_properties.location` | Location: | Location | Alleen leesteken (dubbele punt) verschil. |
| `file_properties.modified` | Modified: | Modified | Alleen leesteken (dubbele punt) verschil. |
| `file_properties.owner` | Owner: | Owner | Alleen leesteken (dubbele punt) verschil. |
| `file_properties.permissions` | Permissions: | Permissions | Alleen leesteken (dubbele punt) verschil. |
| `file_properties.size` | Size: | Size | Alleen leesteken (dubbele punt) verschil. |
| `options.title` | Options | Options configuration | Inhoudelijk verschil — de web-titel is beschrijvender ("Options configuration" vs. "Options"). |

6 van de 9 zijn triviale leesteken-verschillen (trailing `:`); 2 zijn een lichte woordkeuze-variant; 1 (`drop_menu.items_to`) bevat een kapotte pluralisatie-placeholder aan web-kant (`{s}` in plaats van `(s)`) — dat is een bug, geen stijlkeuze, en verdient sowieso reparatie ongeacht de unificatie.

---

## 5. (b) Genuinely desktop-only sleutels

**117 sleutels** hebben geen enkele waarde-match aan web-kant. Verdeling per top-level namespace:

| Namespace | Aantal |
|---|---|
| `dialog` | 28 |
| `menu` | 27 |
| `options` | 26 |
| `toolbar` | 11 |
| `filelist` | 10 |
| `help_dialog` | 5 |
| `tasks` | 5 |
| `editor` | 2 |
| `audio` | 1 |
| `drop_menu` | 1 |
| `search` | 1 |

### Nuance: "near-renames" met ingebakken sneltoets

Van deze 117 zijn er **22** waarbij de desktop-tekst identiek is aan een web-waarde zodra je het sneltoets-suffix (`" (F5)"`, `" (Alt+F4)"`, `" (Ctrl+D)"`, …) weghaalt. Desktop bakt de sneltoets in het menulabel zelf; web laat het label kaal en toont de toets elders (of niet). Dit is een **opmaakverschil, geen nieuwe content**:

| Desktop key | Desktop waarde | Web-tegenhanger(s) (kale tekst) |
|---|---|---|
| `menu.files.copy` | Copy (F5) | menu.copy / common.copy / fkeys.f5 |
| `menu.files.delete` | Delete (F8) | menu.delete / common.delete / fkeys.f8 |
| `menu.files.edit` | Edit (F4) | menu.edit / hotlist.edit / fkeys.f4 |
| `menu.files.new_folder` | New Folder (F7) | menu.mkdir |
| `menu.files.pack` | Pack (Alt+F5) | menu.pack |
| `menu.files.unpack` | Unpack (Alt+F9) | menu.unpack |
| `menu.files.view` | View (F3) | menu.view / fkeys.f3 |
| `menu.files.exit` | Exit (Alt+F4) | menu.exit |
| `menu.selection.select_all` | Select All (Num +) | menu.select_all |
| `menu.selection.unselect_all` | Unselect All (Num -) | menu.unselect_all |
| `menu.selection.invert` | Invert Selection (Num *) | menu.invert_selection |
| `menu.commands.hotlist` | Directory Hotlist (Ctrl+D) | menu.hotlist / hotlist.title |
| `menu.commands.search` | Search (Alt+F7) | menu.search |
| `toolbar.refresh` | Refresh (Ctrl+R) | common.refresh |
| `toolbar.search` | Search (Alt+F7) | menu.search |
| `toolbar.hotlist` | Directory Hotlist (Ctrl+D) | menu.hotlist / hotlist.title |
| `toolbar.brief` | Brief View (Ctrl+F1) | menu.view_brief |
| `toolbar.full` | Full View (Ctrl+F2) | menu.view_full |
| `toolbar.exit` | Exit (F10) | menu.exit |
| `dialog.rename_label` | New Name: | multi_rename.col_new |
| `options.general.selection_style` | Selection Style: | options.selection_style |
| `file_properties... (menu.files.properties)` | Properties (Alt+Enter) | file_properties.tab_properties |

Netto **echt nieuwe** desktop-only content is dus eerder **~95 sleutels** (117 − 22), niet 117.

### Representatieve voorbeelden van écht nieuwe desktop-only content

| Key | Waarde (EN) |
|---|---|
| `audio.system_open_failed` | Failed to open system audio player. Falling back to the built-in miniplayer. |
| `dialog.delete_permanent_prompt` | Are you sure you want to PERMANENTLY delete {n} items? |
| `dialog.delete_trash_prompt` | Are you sure you want to move {n} items to the trash? |
| `dialog.pack_destination` | Destination folder: |
| `dialog.pack_follow_links` | Include symlinks |
| `dialog.pack_info` | The files will be compressed into an archive. |
| `dialog.pack_level` | Compression |
| `dialog.split_info` | Segments will be named with extension .001, .002, etc. |
| `editor.not_text_file` | File is not a valid text file or is too large. |
| `editor.unsaved_changes` | You have unsaved changes. Do you want to close without saving? |
| `filelist.symlink_title` | Symbolic Link |
| `help_dialog.no_topics_match` | No topics match "{query}" |
| `menu.command_palette` | Command Palette |
| `menu.commands.job_list` | Job List (Ctrl+J) |
| `options.appearance.fonts_title` | Typography Settings |
| `options.general.audio_player` | Audio Player: |
| `options.general.nc_mode` | Norton Commander Mode (Right-click selects) |
| `options.general.start_as_root_desc` | Restart the application with root privileges to access protected files. |
| `options.interface.show_alternating_rows` | Show alternating row colors in file lists |
| `tasks.cancel_task` | Cancel Task |

Volledige lijst: zie Bijlage A.

---

## 6. (c) Genuinely web-only sleutels

**256 sleutels** hebben geen enkele waarde-match aan desktop-kant. Verdeling per top-level namespace:

| Namespace | Aantal | Herkenbaar als |
|---|---|---|
| `menu` | 44 | extra menu-items: netwerk, FTP, sortering, tabs, upload — desktop mist deze menu-ingangen (deels omdat desktop andere sneltoetsen/menupaden gebruikt, deels echt afwezige features) |
| `options` | 31 | extra opties-UI (kolom-presets, thema-namen, behaviors-tab) |
| `upload` | 21 | hele **upload-feature** (web-only: bestanden uploaden via de browser — desktop heeft native FS-toegang, geen upload nodig) |
| `file_properties` | 19 | uitgebreide eigenschappen-tab (unix rechten-bits, octal, media-type) — bekend als ⚠️-uitzondering in het migratieplan (web loopt hier voor) |
| `dialogs` | 18 | extra dialogen: sudo/authenticatie, elevation, permission-denied |
| `common` | 17 | generieke labels-verzameling (`open`, `cut`, `paste`, `group`, `comment`, …) — web heeft één centrale `common.*` namespace die op desktop verspreid zit over `filelist.*`/`dialog.*` |
| `help_topics` | 15 | hele **help-inhoudsopgave** (16 topics) — desktop's `help_dialog` heeft geen topic-lijst, alleen chrome-strings |
| `network` | 15 | hele **netwerk-schijven-feature** (verbinden/loskoppelen) — desktop-only relevant op Windows-netwerkshares, ontbreekt momenteel |
| `help_viewer` | 11 | help-viewer chrome (zoeken, breadcrumbs) — desktop's `help_dialog` is een kleinere variant |
| `tasks` | 11 | uitgebreidere takenlijst-UI (waiting/done/stop/dismiss/clear_all) vs. desktop's compactere `tasks.*` |
| `folder_tabs` | 9 | hele **tabbladen-feature** (nieuw/dupliceren/vergrendelen) — ontbreekt op desktop |
| `about` | 8 | tech-stack-opsomming (Svelte/Node/Tailwind/etc.) en copyright-regel |
| `multi_rename` | 8 | hele **Multi-Rename Tool** — ontbreekt op desktop |
| `size_units` | 8 | losse eenheden (K/M/G/T/KB/MB/GB/TB) — desktop interpoleert dit blijkbaar anders (geen losse sleutels) |
| `hotlist` | 5 | los `hotlist.*` blok (desktop's hotlist-strings zitten in `menu.commands.hotlist`/`toolbar.hotlist`, functioneel minder rijk) |
| `image_viewer` | 4 | hele **image-viewer-feature** (zoom/rotate) — ontbreekt op desktop |
| `archive` | 3 | archive-test-resultaatmeldingen |
| `errors` | 3 | generieke foutmeldingen-namespace |
| `drop_menu` | 2 | 2 resterende sleutels (when_dir_exists/when_file_exists met dubbele punt, zie ook §4-conflict-buren) |
| `panel` | 2 | `<DIR>`-marker en `Go up` — desktop lost dit anders op in de filelist-component |
| `fkeys` | 1 | `f9`: "Tasks" (desktop's F9 is "Term" — functioneel verschil, geen vertaalverschil) |
| `meta` | 1 | `language_name` — expliciete taal-displaynaam per bestand; desktop heeft dit niet als sleutel (waarschijnlijk hardcoded in de taalkiezer) |

### Representatieve voorbeelden

| Key | Waarde (EN) |
|---|---|
| `upload.free_space_warning` | Warning: Insufficient free disk space on target. |
| `upload.policy_overwrite_size_differs` | Overwrite if size differs |
| `network.folder_label` | Folder (e.g. {example}) |
| `network.persistent` | Reconnect at sign-in |
| `multi_rename.replace` | Search & Replace: |
| `multi_rename.with` | Replace with: |
| `folder_tabs.close_others` | Close All Other Tabs |
| `folder_tabs.rename_prompt` | Enter new tab name (leave empty to reset): |
| `help_topics.archives` | Working with Archives |
| `help_viewer.breadcrumb` | Help / {topic} |
| `image_viewer.rotate` | Rotate 90° |
| `file_properties.allow_execute` | Allow executing file as program |
| `file_properties.octal` | Octal |
| `dialogs.sudo_message` | Authentication is required to perform this operation as administrator. |
| `dialogs.elevate_message` | You need administrator permission to perform this operation on: |
| `about.copyright` | © 2026 NexusCommander Team by AgilizeNL |
| `about.tech_svelte` | Runes, reactive file list |
| `errors.archive_readonly` | Archives are read-only. You cannot modify the contents of an archive directly. |
| `common.link_target` | Link target |
| `meta.language_name` | English |

Volledige lijst: zie Bijlage B.

---

## 7. Steekproef nl / de (structuurcheck)

Voor elke kant afzonderlijk is per taal (`nl`, `de`, en ter controle ook `fr`, `es`, `pt`) het volledige sleutel-schema vergeleken met het Engelse schema van diezelfde kant:

| Kant | Taal | Sleutels totaal | Ontbrekend t.o.v. EN | Extra t.o.v. EN |
|---|---|---|---|---|
| Desktop | nl | 242 | 0 | 0 |
| Desktop | de | 242 | 0 | 0 |
| Desktop | fr / es / pt | 242 | 0 | 0 |
| Web | nl | 401 | 0 | 0 |
| Web | de | 401 | 0 | 0 |
| Web | fr / es / pt | 401 | 0 | 0 |

**Conclusie: perfecte schema-pariteit binnen elke kant, voor alle 6 talen.** Er is geen taal die intern extra of ontbrekende sleutels heeft — de divergentie zit uitsluitend tussen desktop-schema en web-schema, en dat patroon is (logischerwijs, want het is hetzelfde JSON-skelet) identiek voor elke taal. Een handmatige steekproef bevestigt bovendien dat het om echte vertalingen gaat, geen doorgekopieerde Engelse placeholders:

- `desktop/nl: menu.files.label` = "Bestanden", `web/nl: menu.files` = "Bestanden"
- `desktop/nl: about.title` = "Over NexusCommander", `web/nl: about.title` = "Over NexusCommander"
- `desktop/de: menu.files.label` = "Dateien", `web/de: menu.files` = "Dateien"

**Praktisch gevolg:** een sync-/mergescript dat op basis van dit rapport de Engelse superset-mapping vaststelt, kan **1-op-1 hetzelfde script op de overige 5 talen loslaten** — er is geen per-taal-uitzondering te verwachten.

---

## 8. Bevindingen uit de lopende migratie-code

Tijdens dit onderzoek is ook gekeken naar de al gestarte monorepo-migratie (`packages/ui/src/lib/i18n.ts` en `packages/ui/src/lib/locales/`), relevant voor Fase 5 van het migratieplan:

- **`packages/ui/src/lib/locales/*.json` is al 1-op-1 gekopieerd vanuit `apps/desktop/src/lib/locales/`** (desktop-schema, 242 sleutels, geneste structuur) — de "desktop wordt standaard"-beslissing uit het migratieplan is dus al fysiek doorgevoerd in de bestandsboom, vóórdat de superset-merge heeft plaatsgevonden.
- **`packages/ui/src/lib/components/` is nog leeg (0 bestanden).** Er is dus nog geen enkele gedeelde component die van deze locales gebruikmaakt — dit is het juiste moment om de superset vast te stellen, vóórdat componenten (en dus call-sites) verhuizen.
- **Concrete bug gevonden:** `packages/ui/src/lib/i18n.ts` bevat een `BUILTIN_FALLBACK`-object met een mix van web-achtige *platte* sleutels (bv. `"menu.files": "Files"`, `"actions.no_results": "No actions found"`) als noodfallback, terwijl de primaire lookup (`lookup()`) via `key.split(".").reduce(...)` geneste desktop-paden verwacht (`menu.files.label`, `actions.no_results`). Voor `actions.no_results` staat de **web-waarde** ("No actions found") in de fallback, terwijl het gebundelde desktop-JSON de **desktop-waarde** ("No results found") bevat — exact het conflict uit §4, nu al binnengeslopen in de gedeelde package. De meeste andere fallback-entries (bv. `"menu.files": "Files"`) zijn bovendien dode code: ze matchen nooit een geneste lookup, omdat `dict.menu.files` een object is, geen string. **Aanbeveling:** `BUILTIN_FALLBACK` opnieuw genereren (of verwijderen) zodra de superset-schema vaststaat.
- **Call-site-omvang** (ter inschatting van de rename-impact): desktop gebruikt `$_(...)` op **252 plekken in 28 `.svelte`-bestanden** (217 unieke sleutels); web gebruikt hetzelfde patroon (`svelte-i18n`) op **470 plekken in ~30 bestanden** (333 unieke sleutels). Beide apps gebruiken dus al dezelfde `$_('key.path')`-aanroepconventie — er is geen API-verschil te overbruggen, alleen de sleutelpaden zelf.

---

## 9. Aanbevolen aanpak & inschatting

### 9.1 Canonieke naamgeving

**Volg de al vastgelegde keuze uit het migratieplan: desktop's geneste schema wordt canoniek.** Argumenten om dit te bevestigen i.p.v. te heroverwegen:

- Het is al fysiek doorgevoerd (`packages/ui/src/lib/locales/` = desktop-kopie).
- Desktop's structuur is consistent hiërarchisch (`menu.files.label`, `options.buttons.ok`) en leent zich beter voor een gedeelde componentenboom dan web's plattere, per-scherm-namespace-stijl (`dialogs.*`, `common.*`, `fkeys.*`).
- `packages/ui/src/lib/components/` is nog leeg — er is dus geen sunk cost in web-paden binnen gedeelde componenten.

Waar web's namespace-indeling inhoudelijk beter is voor **nieuwe** (web-only) content — bv. `upload.*`, `network.*`, `multi_rename.*`, `folder_tabs.*`, `help_topics.*`, `image_viewer.*` zijn prima op zichzelf staande top-level namespaces — **die namespaces gewoon overnemen** als nieuwe top-level secties in het desktop-schema; er is geen desktop-tegenhanger om mee te conflicteren.

### 9.2 Omgang met de 54 hoge-zekerheid renames

- Canoniek pad = het **desktop**-pad (tabel §3.1).
- Verwijder de web-tegenhanger uit de superset-JSON.
- Update de web-call-sites die het oude pad gebruikten (mechanisch, scriptbaar via de mapping-tabel — regex-vervanging van `$_('web.key')` naar `$_('desktop.key')` per rij, met een handmatige review-pass omdat een paar paden semantisch net iets anders liggen, bv. `dialog.split_unit` ↔ `size_units.bytes`, waar hergebruik in een andere context een verrassing kan zijn).
- **Geen aliasing/backwards-compat-laag nodig**: dit is een eenmalige interne refactor binnen een monorepo die nog niet extern als library wordt geconsumeerd — een harde rename is goedkoper dan blijvend twee paden onderhouden.

### 9.3 Omgang met de 27 ambigue clusters (100 sleutels)

Niet blokkerend voor Fase 5. Voorstel:

- Voor clusters waar desktop en web toch al hetzelfde concept bedienen in dezelfde component (bv. `Cancel`-knoppen in dialogen die sowieso via Fase 6 worden samengevoegd tot één gedeelde `*Dialog`-component) → **consolideer opportunistisch tijdens die componentmerge**, niet vooraf.
- Voor de rest: **laat de duplicate paden gewoon naast elkaar bestaan** in de superset-JSON (ze hebben toch dezelfde Engelse waarde, dus geen inconsistentie zichtbaar voor de gebruiker) en ruim ze pas op wanneer de bijbehorende component daadwerkelijk wordt samengevoegd.
- Risico van nu-al-forceren: een aantal van deze generieke woorden ("Cancel", "Rename", "Skip") kán in de toekomst per context anders vertaald moeten worden (bv. "Skip" in een upload-conflict vs. "Skip" in een archiefbewerking) — te vroeg samenvoegen tot één sleutel beperkt die vrijheid onnodig.

### 9.4 Omgang met de 9 waarde-conflicten (§4)

Klein, mensgestuurd besluit per regel (geen automatisering nodig):

- 6× triviaal (leesteken) → kies één stijl consistent voor de hele superset (voorstel: **zonder** trailing dubbele punt in `file_properties.*`, aansluitend bij desktop's stijl elders).
- `drop_menu.items_to`: repareer de kapotte pluralisatie in web's bronstring sowieso (bug), neem daarna desktop's vorm over.
- `actions.no_results` en `options.title`: productbeslissing (welke wordt de canonieke Engelse tekst?), daarna in alle 6 talen doorvoeren voor het pad dat overblijft.

### 9.5 Hoeveel nieuwe vertalingen zijn er nodig?

**In principe nul.** Zowel desktop als web zijn **elk al 100% vertaald in 6 talen** voor hún eigen sleutels (bevestigd in §7). Een superset-merge is een **JSON-unie-operatie**, geen vertaalproject: elke genuinely-only sleutel (§5, §6) brengt zijn `nl`/`de`/`fr`/`es`/`pt`-vertaling gewoon mee uit het bronbestand. Vertaalwerk is alleen nodig als de daadwerkelijke **component-samenvoeging** in Fase 6 (bv. `HelpDialog` ↔ `HelpViewer`, `TaskProgress` ↔ `TaskProgressPopUp`) nieuwe, nog niet bestaande UI-teksten introduceert — dat is een aparte, latere kostenpost die buiten deze i18n-analyse valt.

### 9.6 Inschatting vs. het bestaande Fase 5-budget (½ dag)

Het migratieplan begroot Fase 5 ("i18n consolideren") op **½ dag**. Op basis van de concrete cijfers hierboven is dat **optimistisch**. Realistischer, opgesplitst:

| Stap | Inschatting |
|---|---|
| Mergescript bouwen (superset-JSON per taal: unie + 54 renames toepassen + 9 conflicten via config oplossen) — één keer schrijven, 6× (talen) uitvoeren | 0,5 dag |
| Web-call-sites bijwerken voor de 54 hernoemde paden (semi-automatisch + review, ~30 bestanden) | 0,5 dag |
| `BUILTIN_FALLBACK` in `packages/ui/src/lib/i18n.ts` opschonen/regenereren (§8-bug) | 0,25 dag |
| Handmatige regressie: taal wisselen in beide apps/shells, controleren op ontbrekende-sleutel-fallbacks ("key als tekst") in met name de 373 genuinely-only secties | 0,5 dag |
| Buffer voor de 9 conflict-beslissingen + eventuele opportunistische opruiming van ambigue clusters die toch al in scope zijn | 0,25 dag |
| **Totaal** | **~2 dagen** (i.p.v. ½ dag) |

Dit sluit qua volgorde nog steeds aan bij het bestaande plan (Fase 5 vóór Fase 6, superset vaststellen vóórdat componenten verhuizen) — alleen het tijdsbudget verdient bijstelling vóór planning van de sprint.

---

## Bijlage A — volledige lijst genuinely desktop-only (117)

| Key | Waarde (EN) |
|---|---|
| `audio.system_open_failed` | Failed to open system audio player. Falling back to the built-in miniplayer. |
| `dialog.confirm` | Confirm |
| `dialog.copy_to` | Copy {n} files to: |
| `dialog.delete_permanent_prompt` | Are you sure you want to PERMANENTLY delete {n} items? |
| `dialog.delete_trash_prompt` | Are you sure you want to move {n} items to the trash? |
| `dialog.info` | Information |
| `dialog.mkdir_label` | New Directory Name: |
| `dialog.mkdir_title` | Create New Directory |
| `dialog.move_to` | Move {n} files to: |
| `dialog.pack_current_file` | Current: |
| `dialog.pack_destination` | Destination folder: |
| `dialog.pack_estimated` | ETA |
| `dialog.pack_follow_links` | Include symlinks |
| `dialog.pack_format` | Format |
| `dialog.pack_info` | The files will be compressed into an archive. |
| `dialog.pack_level` | Compression |
| `dialog.pack_processed` | Processed |
| `dialog.pack_progress_title` | Compressing... |
| `dialog.pack_prompt` | Archive name: |
| `dialog.pack_starting` | Starting... |
| `dialog.pack_title` | Pack Files |
| `dialog.rename_label` | New Name: |
| `dialog.split_info` | Segments will be named with extension .001, .002, etc. |
| `dialog.total_size` | Total size: {s} |
| `dialog.unpack_title` | Unpack Archive |
| `dialog.verify` | Verify |
| `dialog.warning` | Warning |
| `dialog.when_dir_exists` | When directory exists |
| `dialog.when_file_exists` | When file exists |
| `drop_menu.file_name_template` | File name template: |
| `editor.not_text_file` | File is not a valid text file or is too large. |
| `editor.unsaved_changes` | You have unsaved changes. Do you want to close without saving? |
| `filelist.dirs` | {n} dirs |
| `filelist.empty` | Directory is empty |
| `filelist.f9` | Term |
| `filelist.files` | {n} files |
| `filelist.items` | {n} items |
| `filelist.loading` | Loading directory... |
| `filelist.open_with_always` | Always |
| `filelist.selected` | {n} selected ({s}) |
| `filelist.symlink_title` | Symbolic Link |
| `filelist.total` | {s} total |
| `help_dialog.error` | Error: Failed to load help content |
| `help_dialog.loading` | Loading documentation... |
| `help_dialog.no_topics_match` | No topics match "{query}" |
| `help_dialog.search_placeholder` | Search help topics... |
| `help_dialog.title` | Help Documentation |
| `menu.command_palette` | Command Palette |
| `menu.commands.history` | History (Alt+Down) |
| `menu.commands.hotlist` | Directory Hotlist (Ctrl+D) |
| `menu.commands.job_list` | Job List (Ctrl+J) |
| `menu.commands.search` | Search (Alt+F7) |
| `menu.commands.sync_panels` | Sync Panels |
| `menu.configuration.button_bar` | Button Bar... |
| `menu.configuration.drive_bar` | Drive Bar... |
| `menu.configuration.save_position` | Save Position |
| `menu.files.calculate_space_all` | Calculate All Folder Sizes |
| `menu.files.copy` | Copy (F5) |
| `menu.files.delete` | Delete (F8) |
| `menu.files.edit` | Edit (F4) |
| `menu.files.exit` | Exit (Alt+F4) |
| `menu.files.move` | Move/Rename (F6) |
| `menu.files.new_folder` | New Folder (F7) |
| `menu.files.pack` | Pack (Alt+F5) |
| `menu.files.properties` | Properties (Alt+Enter) |
| `menu.files.start_as_root` | Restart as Root (Ctrl+R) |
| `menu.files.unpack` | Unpack (Alt+F9) |
| `menu.files.view` | View (F3) |
| `menu.help.about` | About NexusCommander |
| `menu.help.contents` | Contents (F1) |
| `menu.selection.invert` | Invert Selection (Num *) |
| `menu.selection.label` | Selection |
| `menu.selection.select_all` | Select All (Num +) |
| `menu.selection.unselect_all` | Unselect All (Num -) |
| `options.appearance.font_drive` | Drive/Shares Bar Font |
| `options.appearance.font_header` | File Header Font |
| `options.appearance.font_main` | Main Font (Fallback) |
| `options.appearance.font_menu` | Menu Bar Font |
| `options.appearance.font_pane` | File Pane Font |
| `options.appearance.fonts_title` | Typography Settings |
| `options.appearance.icon_theme_label` | File & Folder Icon Theme: |
| `options.appearance.select_font_title` | Select Font |
| `options.appearance.theme_label` | Select Application Theme: |
| `options.buttons.browse` | ... |
| `options.buttons.save_as` | Save as |
| `options.columns.view_label` | Columns view: |
| `options.general.audio_player` | Audio Player: |
| `options.general.audio_player_builtin` | Built-in Mini Music Player |
| `options.general.audio_player_system` | System Default Application (External) |
| `options.general.language` | Language Interface: |
| `options.general.nc_mode` | Norton Commander Mode (Right-click selects) |
| `options.general.selection_style` | Selection Style: |
| `options.general.standard_mode` | Standard Mode (Click selects) |
| `options.general.standard_mode_desc` | Windows Mode (Left-click selects, Right-click context menu) |
| `options.general.start_as_root` | Restart as Root (Ctrl+R) |
| `options.general.start_as_root_desc` | Restart the application with root privileges to access protected files. |
| `options.interface.show_alternating_rows` | Show alternating row colors in file lists |
| `options.interface.show_file_sizes_in_bytes` | Show file sizes in bytes |
| `options.interface.show_menu` | Show Main Menu bar |
| `options.interface.show_parent_row` | Show parent directory row ([..]) at top of file list |
| `search.results_prefix` | Search results |
| `tasks.active` | {n} active task(s) |
| `tasks.cancel_task` | Cancel Task |
| `tasks.clear_finished` | Clear finished |
| `tasks.count` | {n} task(s) |
| `tasks.empty` | No tasks |
| `toolbar.brief` | Brief View (Ctrl+F1) |
| `toolbar.exit` | Exit (F10) |
| `toolbar.full` | Full View (Ctrl+F2) |
| `toolbar.home` | Home (Alt+Home) |
| `toolbar.hotlist` | Directory Hotlist (Ctrl+D) |
| `toolbar.layout` | Toggle Layout |
| `toolbar.refresh` | Refresh (Ctrl+R) |
| `toolbar.search` | Search (Alt+F7) |
| `toolbar.terminal` | Terminal (F9) |
| `toolbar.tree` | Toggle Tree |
| `toolbar.up` | Up (Backspace) |

## Bijlage B — volledige lijst genuinely web-only (256)

| Key | Waarde (EN) |
|---|---|
| `about.copyright` | © 2026 NexusCommander Team by AgilizeNL |
| `about.tech_css` | Theming & design tokens |
| `about.tech_lucide` | Crisp icon set |
| `about.tech_node` | Express backend |
| `about.tech_svelte` | Runes, reactive file list |
| `about.tech_tailwind` | Utility-first styling |
| `about.tech_vite` | Fast build & HMR |
| `about.version` | Version |
| `archive.test_error` | Test failed: {error} |
| `archive.test_failed` | Archive is corrupted or invalid. |
| `archive.test_passed` | Archive integrity check passed. |
| `common.accessed` | Accessed |
| `common.changed` | Changed |
| `common.choose` | Choose... |
| `common.coming_soon` | This feature is coming soon! |
| `common.comment` | Comment |
| `common.compressed_size` | Compressed size |
| `common.created` | Created |
| `common.group` | Group |
| `common.link_target` | Link target |
| `common.loading` | Loading... |
| `common.no_ext` | Name without extension |
| `common.open` | Open |
| `common.open_with` | Open with... |
| `common.owner` | Owner |
| `common.path` | Path |
| `common.perm` | Perm |
| `common.type` | Type |
| `dialogs.authenticate` | Authenticate |
| `dialogs.copy_to` | Copy {n} items to: |
| `dialogs.elevate_message` | You need administrator permission to perform this operation on: |
| `dialogs.elevation_failed` | Elevation failed: {error} |
| `dialogs.extract` | Extract |
| `dialogs.extract_to` | Extract {n} items to: |
| `dialogs.mkdir_prompt` | Enter new directory name: |
| `dialogs.move_to` | Move {n} items to: |
| `dialogs.operation_failed` | Operation failed: {error} |
| `dialogs.pack_into` | Pack {n} items into: |
| `dialogs.permission_denied_title` | Permission denied |
| `dialogs.properties` | File Properties |
| `dialogs.rename_prompt` | Enter new name: |
| `dialogs.start` | Start |
| `dialogs.sudo_message` | Authentication is required to perform this operation as administrator. |
| `dialogs.sudo_password_for` | Password for |
| `dialogs.sudo_placeholder` | Enter password... |
| `dialogs.sudo_title` | Authentication Required |
| `drop_menu.when_dir_exists` | When directory exists: |
| `drop_menu.when_file_exists` | When file exists: |
| `errors.archive_readonly` | Archives are read-only. You cannot modify the contents of an archive directly. |
| `errors.nothing_selected` | Nothing is selected. |
| `errors.select_file_first` | Select a file first. |
| `file_properties.accessed` | Accessed |
| `file_properties.allow_execute` | Allow executing file as program |
| `file_properties.bits` | Bits |
| `file_properties.created` | Created |
| `file_properties.execute` | Execute |
| `file_properties.file_name` | File name |
| `file_properties.group` | Group |
| `file_properties.media_type` | Media type |
| `file_properties.octal` | Octal |
| `file_properties.other` | Other |
| `file_properties.path` | Path |
| `file_properties.read` | Read |
| `file_properties.save_failed` | Failed to save properties: {error} |
| `file_properties.size_on_disk` | Size on disk |
| `file_properties.status_changed` | Status changed |
| `file_properties.tab_attributes` | Attributes |
| `file_properties.text_mode` | Text |
| `file_properties.type` | Type |
| `file_properties.write` | Write |
| `fkeys.f9` | Tasks |
| `folder_tabs.close_others` | Close All Other Tabs |
| `folder_tabs.close_tab` | Close Tab |
| `folder_tabs.duplicate_tab` | Duplicate Tab |
| `folder_tabs.lock_tab` | Lock Tab |
| `folder_tabs.locked` | Locked |
| `folder_tabs.new_tab` | New Tab |
| `folder_tabs.rename_prompt` | Enter new tab name (leave empty to reset): |
| `folder_tabs.rename_tab` | Rename Tab... |
| `folder_tabs.unlock_tab` | Unlock Tab |
| `help_topics.advanced` | Advanced Tools |
| `help_topics.archives` | Working with Archives |
| `help_topics.basics` | Getting Started |
| `help_topics.config` | Configuration |
| `help_topics.copy_move` | Copy and Move |
| `help_topics.delete` | Deleting Files |
| `help_topics.intro` | Introduction |
| `help_topics.layout` | Application Layout |
| `help_topics.mkdir` | Creating Folders |
| `help_topics.multi_rename` | Multi-Rename Tool |
| `help_topics.operations` | File Operations |
| `help_topics.options` | Options & Settings |
| `help_topics.search` | Finding Files |
| `help_topics.selection` | Selecting Files |
| `help_topics.themes` | Themes and Icons |
| `help_viewer.breadcrumb` | Help / {topic} |
| `help_viewer.close_hint` | Press Escape to close |
| `help_viewer.could_not_load` | Could not load {file}. |
| `help_viewer.file_not_found` | Help file not found |
| `help_viewer.missing_content` | The requested help topic is unavailable. |
| `help_viewer.no_topics_match` | No help topics match "{query}" |
| `help_viewer.search` | Search help... |
| `help_viewer.search_placeholder` | Search help... |
| `help_viewer.search_results` | Search results ({n}) |
| `help_viewer.title` | NexusCommander Help |
| `help_viewer.topic_not_found` | Topic not found |
| `hotlist.add_current` | Add Current |
| `hotlist.go_to` | Go To |
| `hotlist.path` | Path |
| `hotlist.remove` | Remove |
| `hotlist.title` | Directory Hotlist |
| `image_viewer.rotate` | Rotate 90° |
| `image_viewer.zoom_in` | Zoom in |
| `image_viewer.zoom_out` | Zoom out |
| `image_viewer.zoom_reset` | Reset zoom (double-click) |
| `menu.about` | About... |
| `menu.compare_dirs` | Compare Directories |
| `menu.dual_view` | Show both panels |
| `menu.edit_config` | Edit Config Files... |
| `menu.ftp_connect` | FTP Connect |
| `menu.ftp_disconnect` | FTP Disconnect |
| `menu.ftp_new` | FTP New Connection |
| `menu.help_contents` | Help Index |
| `menu.hotlist` | Directory Hotlist |
| `menu.invert_selection` | Invert Selection |
| `menu.layout_horizontal` | Horizontal split |
| `menu.layout_vertical` | Vertical split |
| `menu.mark` | Mark |
| `menu.mkdir` | New Folder |
| `menu.move` | Move / Rename |
| `menu.multi_rename` | Multi-Rename Tool |
| `menu.net_connections` | Network Connections |
| `menu.net_disconnect` | Disconnect Network Drive |
| `menu.network` | Network |
| `menu.network_connect_drive` | Connect Network Drive |
| `menu.network_disconnect_drive` | Disconnect Network Drive |
| `menu.network_share_folder` | Share Folder |
| `menu.open_terminal` | Open Command Prompt |
| `menu.pack` | Pack |
| `menu.quick_view` | Quick View Panel |
| `menu.restore_selection` | Restore Selection |
| `menu.search` | Search |
| `menu.select_all_files` | Select All Files |
| `menu.show` | Show |
| `menu.sort_date` | Sort by Date |
| `menu.sort_ext` | Sort by Extension |
| `menu.sort_name` | Sort by Name |
| `menu.sort_size` | Sort by Size |
| `menu.task_manager` | Background Transfer Manager |
| `menu.technical_support` | Technical Support |
| `menu.toggle_layout` | Vertical / Horizontal |
| `menu.unpack` | Unpack |
| `menu.unselect_all` | Unselect All |
| `menu.unselect_all_files` | Unselect All Files |
| `menu.upload_files` | Upload Files... |
| `menu.upload_folder` | Upload Folder... |
| `menu.view_brief` | Brief View |
| `menu.view_full` | Full View |
| `menu.view_tree` | Tree View |
| `meta.language_name` | English |
| `multi_rename.col_new` | New Name |
| `multi_rename.col_old` | Old Name |
| `multi_rename.pattern` | Rename pattern: |
| `multi_rename.preview` | Preview |
| `multi_rename.replace` | Search & Replace: |
| `multi_rename.start` | Start Rename |
| `multi_rename.title` | Multi-Rename Tool |
| `multi_rename.with` | Replace with: |
| `network.active_title` | Active Connections |
| `network.col_action` | Action |
| `network.col_drive` | Drive |
| `network.col_path` | Path |
| `network.col_type` | Type |
| `network.connect_btn` | Connect |
| `network.connect_title` | Connect Network Drive |
| `network.connecting` | Connecting... |
| `network.disconnect` | Disconnect |
| `network.drive_label` | Drive |
| `network.folder_label` | Folder (e.g. {example}) |
| `network.loading_drives` | Loading drives... |
| `network.no_connections` | No active connections found. |
| `network.persistent` | Reconnect at sign-in |
| `network.title` | Network Connections |
| `options.behaviors` | Behaviors |
| `options.col_default` | Default (All-purpose) |
| `options.col_development` | Development (Size/Date) |
| `options.col_media` | Media (Detailed Metadata) |
| `options.columns_view` | Columns view name |
| `options.folder_tabs` | Folder Tabs |
| `options.font_drive` | Drive bar font |
| `options.font_header` | Column headers font |
| `options.font_main` | Main window font |
| `options.font_menu` | Menu font |
| `options.font_pane` | File list font |
| `options.fonts` | Fonts |
| `options.icon_theme` | Icon theme |
| `options.language_interface` | Language & Interface |
| `options.left` | Left |
| `options.lucide_desc` | High-performance vector icons (standard) |
| `options.lucide_icons` | Lucide (Internal) |
| `options.nc_mode` | Norton Commander (right-click selects) |
| `options.right` | Right |
| `options.save_as` | Save As... |
| `options.saved` | Saved successfully! |
| `options.saving` | Saving... |
| `options.select_font` | Select Font Family |
| `options.select_theme` | Select color theme |
| `options.selection_style` | Selection Style |
| `options.show_alternating_colors` | Use alternating row colors |
| `options.show_menu` | Show menu bar |
| `options.show_parent_row` | Show [..] to go up |
| `options.themes` | Themes |
| `options.typography` | Typography & Fonts |
| `options.windows_mode` | Windows (right-click context menu) |
| `panel.dir` | <DIR> |
| `panel.up` | Go up |
| `size_units.g` | G |
| `size_units.gb` | GB |
| `size_units.k` | K |
| `size_units.kb` | KB |
| `size_units.m` | M |
| `size_units.mb` | MB |
| `size_units.t` | T |
| `size_units.tb` | TB |
| `tasks.background` | Background |
| `tasks.clear_all` | Clear All |
| `tasks.conflict_file` | File conflict |
| `tasks.dismiss` | Dismiss |
| `tasks.done` | Done |
| `tasks.error_details` | Error Details |
| `tasks.overwrite_all` | Overwrite all |
| `tasks.skip_all` | Skip all |
| `tasks.stop` | Stop |
| `tasks.title` | Background Transfers |
| `tasks.waiting` | Waiting... |
| `upload.apply_to_remaining` | Apply to {n} remaining conflicts |
| `upload.cancel_all` | Cancel All |
| `upload.completed` | Upload completed |
| `upload.conflict_title` | Upload Conflict |
| `upload.failed` | Upload failed |
| `upload.free_space_warning` | Warning: Insufficient free disk space on target. |
| `upload.identical` | identical |
| `upload.larger` | larger |
| `upload.newer` | newer |
| `upload.older` | older |
| `upload.policy_ask` | Ask per file |
| `upload.policy_overwrite` | Overwrite all |
| `upload.policy_overwrite_newer` | Overwrite if newer |
| `upload.policy_overwrite_size_differs` | Overwrite if size differs |
| `upload.policy_rename_all` | Rename all automatically |
| `upload.policy_skip` | Skip all |
| `upload.save_as_default` | Save choice as default (adjustable in Options) |
| `upload.smaller` | smaller |
| `upload.title` | Upload |
| `upload.uploading` | Uploading... |
| `upload.when_exists` | When existing files: |

