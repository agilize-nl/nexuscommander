import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { writeFileAtomically } from '../lib/commit.js';
import { parseClientId, legacySettingsPath, profileSettingsPath } from '../lib/profiles.js';

const router = express.Router();

function settingsPathFor(clientId) {
    return clientId ? profileSettingsPath(clientId) : legacySettingsPath();
}

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
    font_status_name: "Inter",
    font_status_size: 12,
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
    'font_pane_size',
    'font_status_name',
    'font_status_size'
];

/**
 * `null` means "no config at this path" — either it does not exist, or it
 * exists but is not valid JSON, both of which fall back the same way. A
 * permission or other I/O error is neither of those: it must surface as a
 * `500`, not look like an absent config that quietly resolves to defaults.
 */
async function readExistingConfig(configPath) {
    let data;
    try {
        data = await fs.readFile(configPath, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }

    try {
        return JSON.parse(data);
    } catch (error) {
        console.error(`Invalid JSON in ${configPath}, falling back to defaults:`, error.message);
        return null;
    }
}

/** The seed for an unknown client: the legacy config, merged onto defaults. Never touches a profile path. */
async function readSeedConfig() {
    const legacyConfig = await readExistingConfig(legacySettingsPath());
    return mergeConfig({}, legacyConfig ?? {});
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

async function backupExistingConfig(configPath) {
    try {
        await fs.access(configPath);
    } catch {
        return;
    }

    const backupPath = `${configPath}.bak`;
    const timestampedBackupPath = `${configPath}.${timestampForBackup()}.bak`;
    await fs.copyFile(configPath, backupPath);
    await fs.copyFile(configPath, timestampedBackupPath);
}

router.get('/', async (req, res) => {
    let clientId;
    try {
        clientId = parseClientId(req.get('X-NC-Client-Id'));
    } catch (error) {
        return res.status(error.status ?? 500).json({ error: error.message });
    }

    res.vary('X-NC-Client-Id');
    res.set('Cache-Control', 'no-store');

    try {
        if (clientId) {
            const profileConfig = await readExistingConfig(profileSettingsPath(clientId));
            if (profileConfig !== null) {
                return res.json(mergeConfig({}, profileConfig));
            }
            return res.json(await readSeedConfig());
        }

        const legacyConfig = await readExistingConfig(legacySettingsPath());
        res.json(mergeConfig({}, legacyConfig ?? {}));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/', async (req, res) => {
    let clientId;
    try {
        clientId = parseClientId(req.get('X-NC-Client-Id'));
    } catch (error) {
        return res.status(error.status ?? 500).json({ error: error.message });
    }

    try {
        const { newConfig } = req.body;
        const incomingConfig = newConfig || {};
        const configPath = settingsPathFor(clientId);

        let existingConfig;
        if (clientId) {
            const profileConfig = await readExistingConfig(configPath);
            existingConfig = profileConfig !== null ? profileConfig : await readSeedConfig();
        } else {
            existingConfig = (await readExistingConfig(configPath)) ?? {};
        }

        if (hasUserCustomization(existingConfig) && isFreshDefaultConfig(incomingConfig)) {
            return res.status(409).json({
                error: "Refusing to overwrite customized settings with fresh defaults"
            });
        }

        const mergedConfig = mergeConfig(existingConfig, incomingConfig);

        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await backupExistingConfig(configPath);
        await writeFileAtomically(configPath, JSON.stringify(mergedConfig, null, 2));
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

export default router;
