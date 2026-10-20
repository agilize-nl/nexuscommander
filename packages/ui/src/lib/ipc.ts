/**
 * IPC shim for shared components (@nexus/ui).
 *
 * Shared components import the SAME named functions they always did
 * (`import { readDirectory } from "../ipc"`), but here each one delegates to the
 * app-registered adapter via getIpc(). This keeps call sites unchanged when a
 * component moves from an app into packages/ui — only the import path changes.
 *
 * App-resident (not-yet-moved) components keep importing their app's real
 * adapter at `$lib/ipc`; both paths reach the same registered adapter at runtime.
 */
import { getIpc } from "./ipc-registry";
import type { NexusIpc } from "./ipc-contract";

// Re-export all contract types so components can `import type { FileEntry } from "../ipc"`.
export * from "./ipc-contract";
export { getIpc, hasIpc, setIpc } from "./ipc-registry";

/** Delete mode (desktop trash vs permanent; web ignores). */
export enum DeleteMode {
  Permanent = "Permanent",
  Trash = "Trash",
}

type Req<K extends keyof NexusIpc> = NonNullable<NexusIpc[K]>;
const d = getIpc; // local alias

// ===== Required methods (present in both shells) =====
export const readDirectory: Req<"readDirectory"> = (...a) => d().readDirectory(...a);
export const getHomeDir: Req<"getHomeDir"> = (...a) => d().getHomeDir(...a);
export const getParentDir: Req<"getParentDir"> = (...a) => d().getParentDir(...a);
export const getPathInfo: Req<"getPathInfo"> = (...a) => d().getPathInfo(...a);
export const getDrives: Req<"getDrives"> = (...a) => d().getDrives(...a);
export const compareDirectories: Req<"compareDirectories"> = (...a) => d().compareDirectories(...a);
export const createDirectory: Req<"createDirectory"> = (...a) => d().createDirectory(...a);
export const deleteEntry: Req<"deleteEntry"> = (...a) => d().deleteEntry(...a);
export const deleteEntries: Req<"deleteEntries"> = (...a) => d().deleteEntries(...a);
export const renameEntry: Req<"renameEntry"> = (...a) => d().renameEntry(...a);
export const batchRename: Req<"batchRename"> = (...a) => d().batchRename(...a);
export const copyFile: Req<"copyFile"> = (...a) => d().copyFile(...a);
export const copyEntries: Req<"copyEntries"> = (...a) => d().copyEntries(...a);
export const moveEntries: Req<"moveEntries"> = (...a) => d().moveEntries(...a);
export const calculateDirSize: Req<"calculateDirSize"> = (...a) => d().calculateDirSize(...a);
export const saveTextFile: Req<"saveTextFile"> = (...a) => d().saveTextFile(...a);
export const isArchive: Req<"isArchive"> = (...a) => d().isArchive(...a);
export const readArchive: Req<"readArchive"> = (...a) => d().readArchive(...a);
export const archivePack: Req<"archivePack"> = (...a) => d().archivePack(...a);
export const archiveUnpack: Req<"archiveUnpack"> = (...a) => d().archiveUnpack(...a);
export const readFileForViewer: Req<"readFileForViewer"> = (...a) => d().readFileForViewer(...a);
export const taskCreate: Req<"taskCreate"> = (...a) => d().taskCreate(...a);
export const taskExecute: Req<"taskExecute"> = (...a) => d().taskExecute(...a);
export const taskGet: Req<"taskGet"> = (...a) => d().taskGet(...a);
export const taskList: Req<"taskList"> = (...a) => d().taskList(...a);
export const taskCancel: Req<"taskCancel"> = (...a) => d().taskCancel(...a);
export const taskClearFinished: Req<"taskClearFinished"> = (...a) => d().taskClearFinished(...a);
export const resolveTaskConflict: Req<"resolveTaskConflict"> = (...a) => d().resolveTaskConflict(...a);
export const getBookmarks: Req<"getBookmarks"> = (...a) => d().getBookmarks(...a);
export const saveBookmarks: Req<"saveBookmarks"> = (...a) => d().saveBookmarks(...a);
export const addBookmark: Req<"addBookmark"> = (...a) => d().addBookmark(...a);
export const removeBookmark: Req<"removeBookmark"> = (...a) => d().removeBookmark(...a);
export const searchFiles: Req<"searchFiles"> = (...a) => d().searchFiles(...a);
export const openTerminal: Req<"openTerminal"> = (...a) => d().openTerminal(...a);
export const openFile: Req<"openFile"> = (...a) => d().openFile(...a);
export const getOpenWithApps: Req<"getOpenWithApps"> = (...a) => d().getOpenWithApps(...a);
export const openFileWithApp: Req<"openFileWithApp"> = (...a) => d().openFileWithApp(...a);
export const setDefaultApp: Req<"setDefaultApp"> = (...a) => d().setDefaultApp(...a);
export const mapNetworkDrive: Req<"mapNetworkDrive"> = (...a) => d().mapNetworkDrive(...a);
export const disconnectNetworkDrive: Req<"disconnectNetworkDrive"> = (...a) => d().disconnectNetworkDrive(...a);
export const loadLanguageFile: Req<"loadLanguageFile"> = (...a) => d().loadLanguageFile(...a);
export const loadSettings: Req<"loadSettings"> = (...a) => d().loadSettings(...a);
export const saveSettings: Req<"saveSettings"> = (...a) => d().saveSettings(...a);

// ===== Optional capabilities — call sites MUST feature-detect (getIpc().x?.())
// before using these, or via hasCapability below. The delegators assert presence. =====
export const sortDrives: Req<"sortDrives"> = (...a) => d().sortDrives!(...a);
// QSF-008: no desktop backend handler exists for these five — feature-detect first.
export const archiveTest: Req<"archiveTest"> = (...a) => d().archiveTest!(...a);
export const splitFile: Req<"splitFile"> = (...a) => d().splitFile!(...a);
export const combineFiles: Req<"combineFiles"> = (...a) => d().combineFiles!(...a);
export const checkIsBinary: Req<"checkIsBinary"> = (...a) => d().checkIsBinary!(...a);
export const getOS: Req<"getOS"> = (...a) => d().getOS!(...a);
export const archiveCancelPack: Req<"archiveCancelPack"> = (...a) => d().archiveCancelPack!(...a);
export const searchCancel: Req<"searchCancel"> = (...a) => d().searchCancel!(...a);
export const searchListen: Req<"searchListen"> = (...a) => d().searchListen!(...a);
export const openInEditor: Req<"openInEditor"> = (...a) => d().openInEditor!(...a);
export const editConfigFile: Req<"editConfigFile"> = (...a) => d().editConfigFile!(...a);
export const getHelpTopics: Req<"getHelpTopics"> = (...a) => d().getHelpTopics!(...a);
export const getHelpContent: Req<"getHelpContent"> = (...a) => d().getHelpContent!(...a);
export const exitApp: Req<"exitApp"> = (...a) => d().exitApp!(...a);
export const restartAsRoot: Req<"restartAsRoot"> = (...a) => d().restartAsRoot!(...a);
export const isRunningAsRoot: Req<"isRunningAsRoot"> = (...a) => d().isRunningAsRoot!(...a);
export const taskPause: Req<"taskPause"> = (...a) => d().taskPause!(...a);
export const taskResume: Req<"taskResume"> = (...a) => d().taskResume!(...a);
export const getHealth: Req<"getHealth"> = (...a) => d().getHealth!(...a);
export const getParentInfo: Req<"getParentInfo"> = (...a) => d().getParentInfo!(...a);
export const calculateDirSizes: Req<"calculateDirSizes"> = (...a) => d().calculateDirSizes!(...a);
export const resolveOpenAction: Req<"resolveOpenAction"> = (...a) => d().resolveOpenAction!(...a);
export const executeCommand: Req<"executeCommand"> = (...a) => d().executeCommand!(...a);
export const getSystemCapabilities: Req<"getSystemCapabilities"> = (...a) => d().getSystemCapabilities!(...a);
export const openConfigDir: Req<"openConfigDir"> = (...a) => d().openConfigDir!(...a);
export const listLanguages: Req<"listLanguages"> = (...a) => d().listLanguages!(...a);
export const convertPreview: Req<"convertPreview"> = (...a) => d().convertPreview!(...a);
export const remuxPreview: Req<"remuxPreview"> = (...a) => d().remuxPreview!(...a);
export const openOnThisComputer: Req<"openOnThisComputer"> = (...a) => d().openOnThisComputer!(...a);
export const convertFileSrc: Req<"convertFileSrc"> = (...a) => d().convertFileSrc!(...a);
export const listenToTaskProgress: Req<"listenToTaskProgress"> = (...a) => d().listenToTaskProgress!(...a);
export const getUsersGroups: Req<"getUsersGroups"> = (...a) => d().getUsersGroups!(...a);
export const setFileProperties: Req<"setFileProperties"> = (...a) => d().setFileProperties!(...a);
export const getSizeOnDisk: Req<"getSizeOnDisk"> = (...a) => d().getSizeOnDisk!(...a);
export const getSystemUser: Req<"getSystemUser"> = (...a) => d().getSystemUser!(...a);
export const elevateOperation: Req<"elevateOperation"> = (...a) => d().elevateOperation!(...a);
export const setPermissions: Req<"setPermissions"> = (...a) => d().setPermissions!(...a);
export const chown: Req<"chown"> = (...a) => d().chown!(...a);

/** Feature-detect an optional capability on the active adapter. */
export function hasCapability<K extends keyof NexusIpc>(name: K): boolean {
  return typeof (d() as NexusIpc)[name] === "function";
}
