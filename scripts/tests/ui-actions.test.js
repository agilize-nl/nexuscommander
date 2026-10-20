import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';

// Execute actual component handlers, with UI/IPC dependencies replaced by spies.
// BASELINE=HEAD runs the same regressions against the unmodified component source.
function source(file) {
  const text = process.env.BASELINE && file.endsWith('.svelte')
    ? execFileSync('git', ['show', `${process.env.BASELINE}:${file}`], { encoding: 'utf8' })
    : readFileSync(file, 'utf8');
  return text.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? text;
}
function load(file, name, context) {
  const text = source(file);
  const ast = ts.createSourceFile(file + '.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let node;
  function visit(n) {
    if ((ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n)) && n.name?.getText(ast) === name) node = n;
    ts.forEachChild(n, visit);
  }
  visit(ast);
  assert.ok(node, `${file}: ${name} exists`);
  const expression = ts.isVariableDeclaration(node) ? node.initializer.getText(ast) : node.getText(ast).replace(/^export\s+/, '');
  const js = ts.transpile(`globalThis.handler = ${expression}`, { target: ts.ScriptTarget.ES2022 });
  vm.runInContext(js, context);
  return context.handler;
}
class Element { tagName = 'DIV'; closest() { return null; } }
class Custom { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } }
function event(key, modifiers = {}) {
  return { key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, target: null,
    defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() {}, ...modifiers };
}
const list = 'packages/ui/src/lib/components/FileList.svelte';
function harness(file = list) {
  const calls = [];
  const context = vm.createContext({ HTMLElement: Element, CustomEvent: Custom, KeyboardEvent: Custom,
    isActive: true, renamingIndex: null, overlayActive: false, showQuickSearch: false,
    calculatingDirs: new Set(), filteredEntries: [], selectedIndex: 0, containerHeight: 0, ROW_HEIGHT: 20,
    side: 'left', showActionPalette: false, anyOverlayOpen: false, isOverlayActive: false,
    get: value => value, window: { dispatchEvent: e => calls.push([e.type, e.detail]) },
    taskProgress: { toggle: () => calls.push(['tasks']) },
    handleMenuAction: e => calls.push(['action', e.detail]),
    activePanel: { set: value => calls.push(['active', value]) },
    ...Object.fromEntries(['handleSort', 'handleCopy', 'handleMove', 'handleDelete', 'handleMkDir',
      'handleUnpack', 'handleTestArchive', 'handlePack', 'startRename', 'scrollToIndex', 'toggleSelection',
      'getFullPath', 'requestOpen', 'enterEntry', 'selectAll'].map(name => [name, (...args) => calls.push([name, ...args])])) });
  context.shellShortcut = load('packages/ui/src/lib/shortcuts.ts', 'shellShortcut', context);
  context.isTextTarget = load('packages/ui/src/lib/shortcuts.ts', 'isTextTarget', context);
  return { context, calls, run: load(file, 'handleKeydown', context) };
}
for (const [key, column] of [['F3','name'], ['F4','extension'], ['F5','modified'], ['F6','size']]) {
  test(`Ctrl+${key} sorts ${column} without opening a file operation`, () => {
    const h = harness(); h.run(event(key, { ctrlKey: true })); assert.deepEqual(h.calls, [['handleSort',column]]);
  });
}
for (const key of ['F1','F2','F8']) test(`Ctrl+${key} is reserved for the shell`, () => {
  const h = harness(); h.run(event(key, { ctrlKey: true })); assert.deepEqual(h.calls, []);
});
for (const key of ['F3','F4']) test(`${key} tolerates an empty listing`, () => {
  const h = harness(); h.run(event(key)); assert.deepEqual(h.calls, []);
});
test('Alt+F7 does not create a folder', () => {
  const h = harness(); h.run(event('F7', { altKey: true })); assert.deepEqual(h.calls, []);
});
test('Alt+Shift+F9 tests instead of extracting', () => {
  const h = harness(); h.run(event('F9', { altKey: true, shiftKey: true })); assert.deepEqual(h.calls, [['handleTestArchive']]);
});
for (const [key,method,mods,args] of [['F5','handleCopy',{},[]], ['F6','handleMove',{},[]], ['F7','handleMkDir',{},[]], ['F8','handleDelete',{},[false]], ['Delete','handleDelete',{shiftKey:true},[true]], ['F5','handlePack',{altKey:true},[]], ['F9','handleUnpack',{altKey:true},[]]]) {
  test(`${JSON.stringify(mods)} ${key} retains its file action`, () => {
    const h = harness(); h.run(event(key, mods)); assert.deepEqual(h.calls, [[method,...args]]);
  });
}
test('Shift+Down selects the current entry and moves the cursor', () => {
  const h = harness(); h.context.filteredEntries = [{name:'a'}, {name:'b'}]; h.run(event('ArrowDown',{shiftKey:true}));
  assert.deepEqual(h.calls, [['toggleSelection',0], ['scrollToIndex',1]]);
});
for (const app of ['desktop','web']) {
  const file = `apps/${app}/src/routes/+page.svelte`;
  for (const [key, mods, action] of [['F1',{},'help-contents'], ['F9',{},null], ['j',{ctrlKey:true},null], ['F7',{altKey:true},'search'], ['F1',{ctrlKey:true},'view-brief'], ['F2',{ctrlKey:true},'view-full'], ['F8',{ctrlKey:true},'view-tree'], ['u',{ctrlKey:true},'swap-panels'], ['U',{ctrlKey:true,shiftKey:true},'equalize-panels'], ['r',{ctrlKey:true},'refresh']]) {
    test(`${app}: ${JSON.stringify(mods)} ${key} routes once`, () => {
      const h = harness(file); h.run(event(key,mods)); assert.deepEqual(h.calls, [action ? ['action',action] : ['tasks']]);
    });
  }
  test(`${app}: overlays and text editors keep their keyboard input`, () => {
    const h = harness(file); h.context.anyOverlayOpen = true; h.context.isOverlayActive = true;
    h.run(event('F1')); h.run(event('r',{ctrlKey:true})); assert.deepEqual(h.calls, []);
    h.context.anyOverlayOpen = false; h.context.isOverlayActive = false;
    const target = new Element(); target.tagName = 'INPUT'; h.run(event('p',{ctrlKey:true,target})); assert.deepEqual(h.calls, []);
  });
}
test('unpack uses the focused filtered entry', () => {
  const h = harness(); h.context.entries = [{name:'wrong.zip'}]; h.context.filteredEntries = [{name:'right.zip'}];
  Object.assign(h.context, { isInArchive:false, currentPath:'/source', rightPanelPath:{subscribe:fn => {fn('/dest');return () => {}; }},
    getFullPath:e => `/source/${e.name}`, openDialog:d => h.calls.push(d.sourcePaths[0]) });
  load(list,'handleUnpack',h.context)(); assert.deepEqual(h.calls,['/source/right.zip']);
});
test('desktop archive drag copies the archive itself', async () => {
  const h = harness(); Object.assign(h.context, { dropMenu: {files:['/data/backup.zip'],targetDir:'/dest'},
    closeDropMenu: () => {}, startBackgroundTask:async (...args) => h.calls.push(args), tick:async () => {},
    unpackAndReport:async () => h.calls.push(['UNPACK']), refreshPanels:async () => {} });
  h.context.transferEntries = load('apps/desktop/src/routes/+page.svelte','transferEntries',h.context);
  await load('apps/desktop/src/routes/+page.svelte','handleDropMenuAction',h.context)('copy');
  assert.equal(h.calls[0][0], 'copy'); assert.equal(h.calls[0][1][0], '/data/backup.zip');
});
for (const letter of ['a','f','m']) test(`typing ${letter} searches the listing`, () => {
  const h = harness(); h.context.filteredEntries = [{name:'zero'}, {name:letter+'file'}];
  h.run(event(letter)); assert.deepEqual(h.calls,[['scrollToIndex',1]]);
});
for (const app of ['desktop','web']) {
  const file = `apps/${app}/src/routes/+page.svelte`;
  test(`${app}: Shift+F4 opens the terminal`, () => {
    const h = harness(file); h.run(event('F4',{shiftKey:true})); assert.deepEqual(h.calls,[['action','open-terminal']]);
  });
  for (const [action,expected] of [['sort-ext','extension'], ['sort-date','modified']]) test(`${app}: menu ${action} uses the actual column name`, () => {
    const h = harness(); Object.assign(h.context,{showOptions:false, runPanelAction:()=>false, leftPanel:{},rightPanel:{},
      activeOf:()=>({handleSort:col=>h.calls.push(col)})});
    load(file,'handleMenuAction',h.context)(new Custom('nc:menu-action',{detail:action}));
    assert.deepEqual(h.calls,[expected]);
  });
  test(`${app}: tree menu targets the active panel`, () => {
    const h = harness(); Object.assign(h.context,{showOptions:false,twinPanels:{toggleActiveTree:()=>h.calls.push('active-tree')}, activeOf:(_a,b)=>b});
    load(file,'handleMenuAction',h.context)(new Custom('nc:menu-action',{detail:'view-tree'}));
    assert.deepEqual(h.calls,['active-tree']);
  });
  test(`${app}: disconnect opens the connection manager`, () => {
    const h = harness(); h.context.showNetwork=false;
    load(file,'handleMenuAction',h.context)(new Custom('nc:menu-action',{detail:'net-disconnect'})); assert.equal(h.context.showNetwork,true);
  });
  test(`${app}: Options help remains accessible while the dialog is open`, () => {
    const h = harness(); Object.assign(h.context,{showOptions:true,anyOverlayOpen:true,isOverlayActive:true,showHelp:false,runPanelAction:()=>false,leftPanel:{},rightPanel:{}});
    load(file,'handleMenuAction',h.context)(new Custom('nc:menu-action',{detail:'help-options'})); assert.equal(h.context.showHelp,true);
  });
}
for (const action of ['swap-panels','target-source']) test(`menu ${action} uses the same shell route as the palette`, async () => {
  const h = harness(); await load('packages/ui/src/lib/components/MenuBar.svelte','handleItemClick',h.context)({action});
  assert.deepEqual(h.calls,[['nc:menu-action',action]]);
});
test('unsupported archive tools are disabled in the desktop menu', () => {
  const h = harness(); Object.assign(h.context,{$derived:x=>x,$_:x=>x,showUpload:false,showDownload:false,showExit:true,showElevate:true,isRoot:false,showStubTools:false,hasCapability:()=>false});
  const menus=load('packages/ui/src/lib/components/MenuBar.svelte','menus',h.context);
  for (const action of ['test-archive','split','combine']) assert.equal(menus.flatMap(m=>m.items).find(i=>i.action===action).disabled,true);
  assert.ok(!menus.flatMap(m=>m.items).some(i=>i.action==='history'||i.action==='sync-panels'));
});
test('active tree routing uses the right side when the right pane is active', () => {
  const h=harness(); Object.assign(h.context,{activePanel:{subscribe:fn=>{fn('right');return ()=>{};}},toggleLeftTree:()=>h.calls.push('left'),toggleRightTree:()=>h.calls.push('right')});
  load('packages/ui/src/lib/components/TwinPanels.svelte','toggleActiveTree',h.context)(); assert.deepEqual(h.calls,['right']);
});
test('equalizing the divider persists a balanced ratio', () => {
  const h=harness(); Object.assign(h.context,{leftFlex:1.5,rightFlex:0.5,persistLayout:()=>h.calls.push([h.context.leftFlex,h.context.rightFlex])});
  load('packages/ui/src/lib/components/TwinPanels.svelte','equalizePanels',h.context)(); assert.deepEqual(h.calls,[[1,1]]);
});
test('desktop F5 copies a selected ZIP without extracting it', async () => {
  const h=harness(); Object.assign(h.context,{dlgType:'copy',dlgSourcePaths:['/data/backup.zip'],dlgSourceDir:'/data',closeDialog:()=>{},
    startBackgroundTask:async (...args)=>h.calls.push(args),tick:async()=>{},unpackAndReport:async()=>h.calls.push(['UNPACK']),
    refreshPanels:async()=>{}, $_:x=>x, dlgEntries:[]});
  await load('apps/desktop/src/routes/+page.svelte','handleDialogConfirm',h.context)('/dest'); assert.equal(h.calls[0][0],'copy');
});
test('desktop dragging an archive member still extracts the requested entry', async () => {
  const h=harness(); Object.assign(h.context,{$_:x=>x,dropMenu:{files:['/data/backup.zip/folder/file.txt'],targetDir:'/dest'},closeDropMenu:()=>{},
    tick:async()=>{},unpackAndReport:async(...args)=>h.calls.push(args),refreshPanels:async()=>{}});
  h.context.transferEntries = load('apps/desktop/src/routes/+page.svelte','transferEntries',h.context);
  await load('apps/desktop/src/routes/+page.svelte','handleDropMenuAction',h.context)('copy');
  assert.equal(h.calls[0][0],'/data/backup.zip'); assert.equal(h.calls[0][2][0],'folder/file.txt');
});
test('dragging a filtered row uses that row instead of the unfiltered index', () => {
  const h=harness(); const data={}; Object.assign(h.context,{entries:[{name:'wrong'},{name:'right'}],filteredEntries:[{name:'right'}],
    selectedEntries:new Set(),handlePanelFocus:()=>{},getFullPath:e=>'/'+e.name,isInArchive:false,
    document:{body:{classList:{add:()=>{}},appendChild:()=>{}},createElement:()=>({style:{}})},setTimeout:()=>{}});
  load(list,'handleDragStart',h.context)({dataTransfer:{setData:(key,value)=>data[key]=value,setDragImage:()=>{}}},0);
  assert.deepEqual(JSON.parse(data['application/x-nexus-commander-paths']),['/right']);
});
test('clipboard IPC rejection is visible and refreshes the listings', async () => {
  const h=harness(); Object.assign(h.context,{checkReadOnly:()=>false,clipboardStore:{subscribe:fn=>{fn({paths:['/file'],operation:'copy'});return ()=>{};}},
    currentPath:'/dest',onpaste:async()=>{throw new Error('permission denied');},showActionToast:(...args)=>h.calls.push(args)});
  await load(list,'handlePaste',h.context)(); assert.deepEqual(h.calls,[[false,'permission denied',6000],['nc:refresh-panels',undefined]]);
});
test('cutting from an archive leaves the clipboard untouched', () => {
  const h=harness(); h.context.checkReadOnly=()=>true;
  load(list,'handleCut',h.context)(); assert.deepEqual(h.calls,[]);
});
test('Ctrl+Alt+Enter opens the file instead of showing properties', () => {
  const h=harness(); Object.assign(h.context,{filteredEntries:[{name:'file.txt',is_dir:false}],getFullPath:()=>'/file.txt',requestOpen:(...args)=>{h.calls.push(args);return true;}});
  h.run(event('Enter',{ctrlKey:true,altKey:true})); assert.deepEqual(h.calls,[['/file.txt','open']]);
});
test('inline rename refuses an existing name and a slash before calling the backend', async () => {
  for (const [newName, key] of [['b.txt', 'errors.name_exists'], ['sub/a.txt', 'errors.invalid_name']]) {
    const h = harness(); const a = { name: 'a.txt' }; const b = { name: 'b.txt' };
    Object.assign(h.context, { $_: (k) => k, renamingIndex: 0, renameInProgress: false, filteredEntries: [a, b], entries: [a, b],
      renameValue: newName, showActionToast: (...args) => h.calls.push(['toast', args[1]]),
      renameEntry: async () => { h.calls.push(['backend']); return { success: true }; } });
    await load(list, 'confirmRename', h.context)();
    assert.deepEqual(h.calls, [['toast', key]], newName);
    assert.equal(h.context.renamingIndex, 0, 'the input stays open so the name can be fixed');
  }
});
test('paste goes to the shell (task queue) instead of replacing in place', async () => {
  for (const operation of ['copy', 'cut']) {
    const h = harness(); let cleared = false;
    Object.assign(h.context, { checkReadOnly: () => false, currentPath: '/dest', clearClipboard: () => { cleared = true; },
      clipboardStore: { subscribe: fn => { fn({ paths: ['/src/a.txt'], operation }); return () => {}; } },
      onpaste: async (request) => h.calls.push(request), showActionToast: (...args) => h.calls.push(['toast', ...args]) });
    await load(list, 'handlePaste', h.context)();
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])), { operation: operation === 'copy' ? 'copy' : 'move', sources: ['/src/a.txt'], targetDir: '/dest' });
    assert.equal(cleared, operation === 'cut', 'a cut clipboard is spent once the move is queued');
  }
});
// Upload cancellation used to be recognised by comparing the error *message*
// with 'Upload aborted'. The message is translated now, so the abort is marked
// by name; this pins that an aborted XHR still yields an AbortError.
test('an aborted web upload rejects with an AbortError, whatever its translated message', async () => {
  const h = harness();
  class FakeXhr { upload = {}; open() {} setRequestHeader() {} send() {} abort() { this.onabort?.(); } }
  Object.assign(h.context, { XMLHttpRequest: FakeXhr, URLSearchParams, API: '/api', get: (s) => s, _: (k) => `translated:${k}` });
  const upload = load('apps/web/src/lib/upload/uploadClient.ts', 'uploadOneFile', h.context);
  const handle = upload('/dir', 'a.txt', { size: 1, lastModified: 0 }, { overwrite: false });
  handle.abort();
  const err = await handle.promise.then(() => null, (e) => e);
  assert.equal(err?.name, 'AbortError');
  assert.equal(err?.message, 'translated:upload.error_aborted');
});
test('shortcut labels use the keyboard names of the UI language', async () => {
  const { displayShortcut } = await import('../../packages/ui/src/lib/shortcuts.ts').catch(() => ({}));
  const h = harness(); Object.assign(h.context, {});
  const fn = displayShortcut ?? load('packages/ui/src/lib/shortcuts.ts', 'displayShortcut', h.context);
  const de = { 'keys.ctrl': 'Strg', 'keys.insert': 'Einfg', 'keys.num': 'Num', 'keys.pgup': 'Bild↑' };
  const t = (k) => de[k] ?? k;
  assert.equal(fn('Ctrl+Insert', t), 'Strg+Einfg');
  assert.equal(fn('Ctrl+Num +', t), 'Strg+Num +');
  assert.equal(fn('F5', t), 'F5', 'F-keys are not renamed');
  assert.equal(fn('PgUp', t), 'Bild↑');
});
