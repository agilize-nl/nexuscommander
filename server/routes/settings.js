import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const router = express.Router();
const settingsPath = path.join(os.homedir(), '.config/nexuscommander/config.json');

const DEFAULT_COLUMNS = [
    { caption: "Name", width: 250, align: "left", field_contents: "FileName" },
    { caption: "Ext", width: 80, align: "left", field_contents: "FileExt" },
    { caption: "Size", width: 100, align: "right", field_contents: "FileSize" },
    { caption: "Date", width: 140, align: "left", field_contents: "FileTime" }
];

const DEFAULT_CONFIG = {
    language: "en",
    theme: "midnight",
    layout_show_menu: true,
    layout_show_toolbar: true,
    show_folder_tabs: true,
    layout_show_path: true,
    layout_show_parent_dir_row: true,
    layout_is_vertical: true,
    layout_single_view: false,
    layout_panel_ratio: 0.5,
    layout_left_view_mode: "full",
    layout_right_view_mode: "full",
    show_alternating_row_colors: true,
    behavior_selection_mode: "NC",
    columns: DEFAULT_COLUMNS,
    custom_columns: "Default",
    font_main_name: "Inter",
    font_main_size: 12,
    font_menu_name: "Inter",
    font_menu_size: 12,
    font_drive_name: "Inter",
    font_drive_size: 12,
    font_tab_name: "Inter",
    font_tab_size: 12,
    font_header_name: "Inter",
    font_header_size: 12,
    font_pane_name: "Inter",
    font_pane_size: 12,
    left_tabs: [],
    right_tabs: [],
    left_active_tab: "",
    right_active_tab: "",
    file_op_options: {
        when_exists: "ask",
        verify: true,
        check_free_space: true,
        copy_attributes: true,
        copy_date_time: true
    }
};

const DEFAULT_PROTECTED_KEYS = [
    'language',
    'theme',
    'layout_show_menu',
    'layout_show_toolbar',
    'show_folder_tabs',
    'layout_show_path',
    'layout_show_parent_dir_row',
    'layout_is_vertical',
    'layout_single_view',
    'layout_panel_ratio',
    'layout_left_view_mode',
    'layout_right_view_mode',
    'show_alternating_row_colors',
    'behavior_selection_mode',
    'custom_columns',
    'font_main_name',
    'font_main_size',
    'font_menu_name',
    'font_menu_size',
    'font_drive_name',
    'font_drive_size',
    'font_tab_name',
    'font_tab_size',
    'font_header_name',
    'font_header_size',
    'font_pane_name',
    'font_pane_size'
];

async function readExistingConfig() {
    try {
        const data = await fs.readFile(settingsPath, 'utf8');
        return JSON.parse(data);
    } catch {
        return {};
    }
}

function mergeConfig(existingConfig = {}, incomingConfig = {}) {
    const merged = {
        ...DEFAULT_CONFIG,
        ...existingConfig,
        ...incomingConfig,
        file_op_options: {
            ...DEFAULT_CONFIG.file_op_options,
            ...(existingConfig.file_op_options || {}),
            ...(incomingConfig.file_op_options || {})
        }
    };

    const existingColumns = Array.isArray(existingConfig.columns) ? existingConfig.columns : [];
    const incomingColumns = Array.isArray(incomingConfig.columns) ? incomingConfig.columns : null;
    const existingHasCustomColumns = existingColumns.length > 0 && !columnsEqual(existingColumns, DEFAULT_COLUMNS);
    const incomingHasDefaultColumns = incomingColumns !== null && columnsEqual(incomingColumns, DEFAULT_COLUMNS);
    const incomingRequestsDefaultColumns = incomingConfig.custom_columns === "Default";

    // Protect custom columns from stale/default clients that save default or
    // empty columns during or shortly after a release refresh.
    if (
        incomingColumns &&
        incomingColumns.length > 0 &&
        !(existingHasCustomColumns && (incomingHasDefaultColumns || incomingRequestsDefaultColumns))
    ) {
        merged.columns = incomingColumns;
    } else if (existingColumns.length > 0) {
        merged.columns = existingColumns;
    } else {
        merged.columns = DEFAULT_COLUMNS;
    }

    if (
        (!incomingColumns || incomingColumns.length === 0 || (existingHasCustomColumns && (incomingHasDefaultColumns || incomingRequestsDefaultColumns))) &&
        existingColumns.length > 0 &&
        existingConfig.custom_columns
    ) {
        merged.custom_columns = existingConfig.custom_columns;
    }

    return merged;
}

function normalizeForCompare(value) {
    return JSON.stringify(value ?? null);
}

function columnsEqual(a = [], b = []) {
    return normalizeForCompare(a) === normalizeForCompare(b);
}

function isDefaultishTab(tab) {
    return tab &&
        tab.path === os.homedir() &&
        tab.label === path.basename(os.homedir()) &&
        !tab.custom_label &&
        tab.locked === false;
}

function isFreshDefaultConfig(config = {}) {
    for (const key of DEFAULT_PROTECTED_KEYS) {
        if (normalizeForCompare(config[key]) !== normalizeForCompare(DEFAULT_CONFIG[key])) {
            return false;
        }
    }

    if (!columnsEqual(config.columns, DEFAULT_COLUMNS)) return false;

    const leftTabs = Array.isArray(config.left_tabs) ? config.left_tabs : [];
    const rightTabs = Array.isArray(config.right_tabs) ? config.right_tabs : [];
    const hasOnlyFreshTabs =
        leftTabs.length <= 1 &&
        rightTabs.length <= 1 &&
        leftTabs.every(isDefaultishTab) &&
        rightTabs.every(isDefaultishTab);

    return hasOnlyFreshTabs;
}

function hasUserCustomization(config = {}) {
    if (Object.keys(config).length === 0) return false;
    return !isFreshDefaultConfig(mergeConfig({}, config));
}

function timestampForBackup() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

async function backupExistingConfig() {
    try {
        await fs.access(settingsPath);
    } catch {
        return;
    }

    const backupPath = `${settingsPath}.bak`;
    const timestampedBackupPath = `${settingsPath}.${timestampForBackup()}.bak`;
    await fs.copyFile(settingsPath, backupPath);
    await fs.copyFile(settingsPath, timestampedBackupPath);
}

router.get('/', async (req, res) => {
    try {
        const config = await readExistingConfig();
        res.json(mergeConfig({}, config));
    } catch (error) {
        // Return default config if not found
        res.json(DEFAULT_CONFIG);
    }
});

router.post('/', async (req, res) => {
    try {
        const { newConfig } = req.body;
        const existingConfig = await readExistingConfig();
        const incomingConfig = newConfig || {};

        if (hasUserCustomization(existingConfig) && isFreshDefaultConfig(incomingConfig)) {
            return res.status(409).json({
                error: "Refusing to overwrite customized settings with fresh defaults"
            });
        }

        const mergedConfig = mergeConfig(existingConfig, incomingConfig);
        const tempPath = `${settingsPath}.tmp`;

        await fs.mkdir(path.dirname(settingsPath), { recursive: true });
        await backupExistingConfig();
        await fs.writeFile(tempPath, JSON.stringify(mergedConfig, null, 2));
        await fs.rename(tempPath, settingsPath);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

export default router;
