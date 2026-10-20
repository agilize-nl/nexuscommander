// "Open with..." native options — web backend guards and .desktop parsing.
//
// These test behaviour, not source text. An earlier version of this file only
// asserted that certain identifiers appeared in the source, which stayed green
// while the web backend was missing both the desktop-entry validation and the
// launchability filter that open_with.rs has. See CLAUDE.md, "Verify a check
// can fail".

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    execBinaryFromExecLine,
    binaryExists,
    parseDesktopEntry,
    isLaunchable,
    isKnownDesktopEntry,
    getDesktopAppDirs,
    resolveIconPath
} from "../../apps/web/server/routes/system.js";

const entry = (body) => parseDesktopEntry(`[Desktop Entry]\nName=Test\n${body}`);

test("extracts the binary from an Exec line", () => {
    assert.equal(execBinaryFromExecLine("vim %F"), "vim");
    assert.equal(execBinaryFromExecLine("/usr/bin/gvim -f %F"), "/usr/bin/gvim");
    assert.equal(execBinaryFromExecLine('"/opt/my app/bin" %f'), "/opt/my app/bin");
    assert.equal(execBinaryFromExecLine("   "), null);
    assert.equal(execBinaryFromExecLine(null), null);
});

test("resolves binaries against PATH and absolute paths", () => {
    assert.ok(binaryExists("sh"));
    assert.ok(binaryExists("/bin/sh"));
    assert.ok(!binaryExists("totally-bogus-binary-xyz-nc-test"));
    assert.ok(!binaryExists("/bin/totally-bogus-binary-xyz-nc-test"));
    assert.ok(!binaryExists(""));
    assert.ok(!binaryExists(null));
});

test("parses the main section and ignores [Desktop Action] sub-sections", () => {
    const parsed = parseDesktopEntry(
        "[Desktop Entry]\nName=Real\nIcon=real-icon\nMimeType=text/plain;text/html;\n" +
        "Exec=sh %F\n[Desktop Action new]\nName=Action\nExec=other"
    );
    assert.equal(parsed.name, "Real");
    assert.equal(parsed.icon, "real-icon");
    assert.deepEqual(parsed.mimeTypes, ["text/plain", "text/html"]);
    assert.equal(parsed.execBinary, "sh");
    assert.equal(parsed.noDisplay, false);
});

test("honours NoDisplay and Hidden", () => {
    assert.equal(entry("NoDisplay=true").noDisplay, true);
    assert.equal(entry("Hidden=true").noDisplay, true);
    assert.equal(entry("Exec=sh %F").noDisplay, false);
});

test("rejects entries whose binary is missing", () => {
    // The vim-common case: desktop file installed, binary is not.
    assert.ok(!isLaunchable(entry("TryExec=totally-bogus-binary-xyz-nc-test\nExec=sh %F")));
    assert.ok(!isLaunchable(entry("Exec=totally-bogus-binary-xyz-nc-test %F")));
    assert.ok(!isLaunchable(entry("Comment=No exec line at all")));
});

test("rejects terminal apps even when installed", () => {
    assert.ok(!isLaunchable(entry("Exec=sh %F\nTerminal=true")));
});

test("accepts installed graphical apps", () => {
    assert.ok(isLaunchable(entry("Exec=sh %F")));
    assert.ok(isLaunchable(entry("TryExec=sh\nExec=sh %F\nTerminal=false")));
});

test("isKnownDesktopEntry rejects traversal, separators and junk", () => {
    for (const bad of [
        "../../../etc/passwd",
        "some/dir/app.desktop",
        "some\\dir\\app.desktop",
        "..",
        "",
        null,
        undefined,
        42
    ]) {
        assert.ok(!isKnownDesktopEntry(bad), `${String(bad)} must be rejected`);
    }

    // Isolate the `..` guard from the separator guard: a name containing `..`
    // but no separator must still be refused, even though such a file could
    // legitimately be created inside an application directory.
    const dir = getDesktopAppDirs().find((d) => {
        try {
            fs.accessSync(d, fs.constants.W_OK);
            return fs.statSync(d).isDirectory();
        } catch {
            return false;
        }
    });
    if (dir) {
        const name = `nc..traversal-test-${process.pid}.desktop`;
        const file = path.join(dir, name);
        fs.writeFileSync(file, "[Desktop Entry]\nName=NC Test\nExec=sh %F\n");
        try {
            assert.ok(
                !isKnownDesktopEntry(name),
                "a name containing .. must be refused even when the file exists"
            );
        } finally {
            fs.rmSync(file, { force: true });
        }
    }
});

test("isKnownDesktopEntry rejects entries that are not actually installed", () => {
    assert.ok(!isKnownDesktopEntry("totally-bogus-app-name-xyz-nc-test.desktop"));
});

test("isKnownDesktopEntry accepts a real file in a real application directory", (t) => {
    const dirs = getDesktopAppDirs().filter((d) => {
        try {
            return fs.statSync(d).isDirectory();
        } catch {
            return false;
        }
    });
    const writable = dirs.find((d) => {
        try {
            fs.accessSync(d, fs.constants.W_OK);
            return true;
        } catch {
            return false;
        }
    });
    if (!writable) {
        t.skip("no writable application directory on this machine");
        return;
    }
    const name = `nc-open-with-test-${process.pid}.desktop`;
    const file = path.join(writable, name);
    fs.writeFileSync(file, "[Desktop Entry]\nName=NC Test\nExec=sh %F\n");
    try {
        assert.ok(isKnownDesktopEntry(name));
    } finally {
        fs.rmSync(file, { force: true });
    }
    assert.ok(!isKnownDesktopEntry(name), "must stop matching once removed");
});

test("getDesktopAppDirs covers snap, flatpak and XDG_DATA_DIRS", () => {
    const previous = process.env.XDG_DATA_DIRS;
    process.env.XDG_DATA_DIRS = "/opt/nc-test-xdg:/opt/nc-test-two/applications";
    try {
        const dirs = getDesktopAppDirs();
        assert.ok(dirs.includes("/var/lib/snapd/desktop/applications"));
        assert.ok(dirs.includes("/var/lib/flatpak/exports/share/applications"));
        assert.ok(dirs.includes("/usr/share/applications"));
        assert.ok(dirs.includes(path.join(os.homedir(), ".local/share/applications")));
        assert.ok(
            dirs.includes("/opt/nc-test-xdg/applications"),
            "XDG_DATA_DIRS entries get the /applications suffix"
        );
        assert.ok(
            dirs.includes("/opt/nc-test-two/applications"),
            "an entry already ending in /applications is not doubled"
        );
    } finally {
        if (previous === undefined) delete process.env.XDG_DATA_DIRS;
        else process.env.XDG_DATA_DIRS = previous;
    }
});

test("both backends validate the desktop entry before launching", () => {
    const rust = fs.readFileSync("apps/desktop/src-tauri/src/open_with.rs", "utf8");
    const web = fs.readFileSync("apps/web/server/routes/system.js", "utf8");

    // Every IPC/HTTP-reachable launch path must be gated. This is a parity
    // check between the two backends, so it stays a source-level assertion.
    for (const command of ["open_file_with_app", "set_default_app"]) {
        const body = rust.split(`pub fn ${command}(`)[1];
        assert.ok(body, `${command} must exist in open_with.rs`);
        assert.ok(
            body.slice(0, 400).includes("is_known_desktop_entry"),
            `${command} must validate its desktop_entry`
        );
    }
    for (const route of ["/open-file-with", "/set-default-app"]) {
        const body = web.split(`router.post('${route}'`)[1];
        assert.ok(body, `${route} must exist in system.js`);
        assert.ok(
            body.slice(0, 800).includes("isKnownDesktopEntry"),
            `${route} must validate its desktopEntry`
        );
    }
});

test("all 6 locale files declare the open_with native keys", () => {
    for (const lang of ["en", "nl", "de", "fr", "es", "pt"]) {
        const doc = JSON.parse(
            fs.readFileSync(`packages/ui/src/lib/locales/${lang}.json`, "utf8")
        );
        assert.ok(doc.common?.system_default, `${lang}.json missing common.system_default`);
        assert.ok(doc.filelist?.system_editor, `${lang}.json missing filelist.system_editor`);
        assert.ok(doc.filelist?.system_terminal, `${lang}.json missing filelist.system_terminal`);
        assert.ok(
            doc.filelist?.system_file_manager,
            `${lang}.json missing filelist.system_file_manager`
        );
        assert.ok(doc.filelist?.internal_viewer, `${lang}.json missing filelist.internal_viewer`);
    }
});

test("resolveIconPath returns a real path or null, never a bare icon name", async () => {
    // The return value promises a filesystem path. An unresolvable theme icon
    // name must come back as null rather than echoing the input, otherwise the
    // frontend has to re-derive "is this actually a path?" from the string.
    assert.equal(await resolveIconPath("totally-bogus-icon-xyz-nc-test"), null);
    assert.equal(await resolveIconPath("/nonexistent/xyz-nc-test.png"), null);
    assert.equal(await resolveIconPath(""), null);
    assert.equal(await resolveIconPath(null), null);

    // An absolute path that does exist comes back unchanged.
    const tmp = path.join(os.tmpdir(), `nc-icon-test-${process.pid}.png`);
    fs.writeFileSync(tmp, "");
    try {
        assert.equal(await resolveIconPath(tmp), tmp);
    } finally {
        fs.unlinkSync(tmp);
    }
});
