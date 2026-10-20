use std::process::Command;

/// Start a program this app does not wait for, and reap it once it exits.
///
/// Dropping a `Child` does not wait for it, so on Unix an exited launcher
/// (`gtk-launch`, `xdg-open`, `gio open` all exit almost at once) stayed a
/// zombie for as long as NexusCommander ran — one per "open", per terminal,
/// per editor launch. The waiting thread is blocked in `waitpid` and costs
/// nothing else.
pub(crate) fn spawn_reaped(cmd: &mut Command) -> std::io::Result<u32> {
    let mut child = cmd.spawn()?;
    let pid = child.id();
    std::thread::Builder::new()
        .name("nc-reaper".into())
        .spawn(move || {
            let _ = child.wait();
        })?;
    Ok(pid)
}

/// Resolve `name` to an actual executable file: either an absolute/relative
/// path that exists, or a bare name found on `$PATH`. Used before trusting
/// environment variables like `$TERMINAL`/`$VISUAL`/`$EDITOR` as a program
/// to spawn, so a stray or unset env var can't silently do nothing useful
/// or point at a non-existent path we'd otherwise try to exec.
#[cfg(target_os = "linux")]
fn resolve_program(name: &str) -> Option<std::path::PathBuf> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    let path = std::path::Path::new(name);
    if name.contains('/') {
        return if path.is_file() {
            Some(path.to_path_buf())
        } else {
            None
        };
    }
    let path_var = std::env::var_os("PATH")?;
    std::env::split_paths(&path_var)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

#[cfg(target_os = "linux")]
fn launch_with_default_app(path: &str) -> Result<(), String> {
    let mut attempts = Vec::new();

    match Command::new("xdg-mime")
        .args(["query", "filetype", path])
        .output()
    {
        Ok(mime_output) if mime_output.status.success() => {
            let mimetype = String::from_utf8_lossy(&mime_output.stdout)
                .trim()
                .to_string();
            if !mimetype.is_empty() {
                match Command::new("xdg-mime")
                    .args(["query", "default", &mimetype])
                    .output()
                {
                    Ok(default_output) if default_output.status.success() => {
                        let desktop_entry = String::from_utf8_lossy(&default_output.stdout)
                            .trim()
                            .to_string();
                        if !desktop_entry.is_empty() {
                            let app_id = desktop_entry.trim_end_matches(".desktop");
                            match spawn_reaped(Command::new("gtk-launch").args([app_id, path])) {
                                Ok(_) => return Ok(()),
                                Err(e) => attempts.push(format!("gtk-launch default app: {}", e)),
                            }
                        }
                    }
                    Ok(default_output) => attempts.push(format!(
                        "xdg-mime default lookup exited with {}",
                        default_output.status
                    )),
                    Err(e) => attempts.push(format!("xdg-mime default lookup: {}", e)),
                }
            }
        }
        Ok(mime_output) => attempts.push(format!(
            "xdg-mime filetype lookup exited with {}",
            mime_output.status
        )),
        Err(e) => attempts.push(format!("xdg-mime filetype lookup: {}", e)),
    }

    for (command, args) in [("gio", vec!["open", path]), ("xdg-open", vec![path])] {
        match spawn_reaped(Command::new(command).args(args)) {
            Ok(_) => return Ok(()),
            Err(e) => attempts.push(format!("{}: {}", command, e)),
        }
    }

    Err(format!(
        "Could not open file with a system app. {}",
        attempts.join(" | ")
    ))
}

#[tauri::command]
pub fn open_terminal(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // QSF-006: this one is safe to leave on `cmd`. Every element of the
        // command line is a literal — `path` reaches the child through
        // `current_dir`, which is a CreateProcess parameter and never part of
        // the string cmd.exe re-parses. Launching an interactive console
        // genuinely needs `start`, so there is nothing to replace it with.
        spawn_reaped(
            Command::new("cmd")
                .arg("/C")
                .arg("start")
                .arg("cmd")
                .current_dir(path),
        )
        .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        spawn_reaped(Command::new("open").arg("-a").arg("Terminal").arg(&path))
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        // For Unix desktop environments, try to open the default terminal emulator
        // We prioritize $TERMINAL if set, else fallback to standard XDG tools
        if let Ok(terminal) = std::env::var("TERMINAL") {
            if resolve_program(&terminal).is_some() {
                spawn_reaped(Command::new(terminal.trim()).current_dir(&path))
                    .map_err(|e| format!("Failed to launch $TERMINAL: {}", e))?;
                return Ok(());
            }
            // $TERMINAL is set but doesn't resolve to a real executable:
            // fall through to the standard XDG tools below instead of
            // blindly exec'ing an unresolvable value.
        }

        // Usually works well across desktops if no explicit TERMINAL is set
        spawn_reaped(Command::new("xdg-terminal").current_dir(&path))
            // Fallback to gnome-terminal if xdg-terminal fails
            .or_else(|_| spawn_reaped(Command::new("gnome-terminal").current_dir(&path)))
            // Extra fallback
            .or_else(|_| spawn_reaped(Command::new("xterm").current_dir(&path)))
            .map_err(|e| format!("Could not open terminal: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn open_file(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // QSF-006: `path` is user-derived, so it must not reach a command
        // processor. This used to be `cmd /C start "" <path>`; passing an
        // argument array does not save you there, because the program being
        // spawned IS the shell — cmd.exe re-tokenises the reconstructed command
        // line with its own grammar (`&`, `|`, `^`, `%VAR%`) after Rust's
        // quoting has been applied.
        //
        // tauri-plugin-opener enables open's `shellexecute-on-windows` feature,
        // so this resolves to ShellExecuteExW: a Win32 call taking a wide
        // string, with no shell anywhere in the path.
        tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        spawn_reaped(Command::new("open").arg(&path)).map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        launch_with_default_app(&path)?;
    }
    Ok(())
}
#[tauri::command]
pub fn open_in_editor(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // QSF-006: see open_file. The old code sent `path` through
        // `cmd /C start "" <editor> <path>`, which is the injection point.
        //
        // The `cmd /C where <editor>` probe that guarded it was also useless:
        // `.output().is_ok()` reports success whenever cmd.exe itself could be
        // spawned, regardless of whether `where` actually found the editor. It
        // therefore always took the first branch. Dropping it loses no
        // behaviour — ShellExecuteExW already fails when the program is absent,
        // so trying each candidate in turn is the real probe.
        let editors = ["code.cmd", "code-insiders.cmd", "subl.exe", "notepad.exe"];
        for editor in editors {
            if tauri_plugin_opener::open_path(&path, Some(editor)).is_ok() {
                return Ok(());
            }
        }
        // Last resort: whatever the system associates with the file type.
        tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        // -e: opens the file in TextEdit
        spawn_reaped(Command::new("open").arg("-e").arg(&path)).map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        // Try $VISUAL then $EDITOR, but only if they resolve to a real
        // executable so an unset/bogus value falls through to the GUI list.
        for var in ["VISUAL", "EDITOR"] {
            if let Ok(editor) = std::env::var(var) {
                if resolve_program(&editor).is_some()
                    && spawn_reaped(Command::new(editor.trim()).arg(&path)).is_ok()
                {
                    return Ok(());
                }
            }
        }

        // Try GUI editors
        let gui_editors = [
            "code",
            "subl",
            "gedit",
            "kate",
            "gnome-text-editor",
            "xed",
            "mousepad",
        ];
        for editor in gui_editors {
            if resolve_program(editor).is_some()
                && spawn_reaped(Command::new(editor).arg(&path)).is_ok()
            {
                return Ok(());
            }
        }

        // Fallback to xdg-open
        spawn_reaped(Command::new("xdg-open").arg(&path))
            .map_err(|e| format!("Could not open editor or file: {}", e))?;
    }
    Ok(())
}

#[cfg(all(test, target_os = "linux"))]
mod resolve_program_tests {
    use super::resolve_program;

    #[test]
    fn absolute_path_that_exists_resolves() {
        assert!(resolve_program("/bin/sh").is_some() || resolve_program("/usr/bin/sh").is_some());
    }

    #[test]
    fn absolute_path_that_does_not_exist_is_rejected() {
        assert!(resolve_program("/definitely/not/a/real/binary-xyz").is_none());
    }

    #[test]
    fn bare_name_found_on_path_resolves() {
        // `ls` should always be present in the sandboxed test environment's PATH.
        assert!(resolve_program("ls").is_some());
    }

    #[test]
    fn bare_name_not_on_path_is_rejected() {
        assert!(resolve_program("totally-bogus-binary-name-xyz-nc-test").is_none());
    }

    #[test]
    fn empty_or_blank_value_is_rejected() {
        assert!(resolve_program("").is_none());
        assert!(resolve_program("   ").is_none());
    }
}

#[cfg(all(test, target_os = "linux"))]
mod reaping_tests {
    use super::spawn_reaped;
    use std::process::Command;
    use std::time::{Duration, Instant};

    /// A launched program that exits must disappear from the process table,
    /// not linger as a zombie (state `Z` in /proc/<pid>/stat).
    #[test]
    fn an_exited_launch_leaves_no_zombie() {
        let pid = spawn_reaped(&mut Command::new("true")).expect("`true` must be spawnable");
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
                Err(_) => return, // reaped
                Ok(stat) if Instant::now() > deadline => {
                    panic!("pid {pid} was never reaped: {stat}");
                }
                Ok(_) => std::thread::sleep(Duration::from_millis(20)),
            }
        }
    }
}
