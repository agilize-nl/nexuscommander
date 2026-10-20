use std::process::Command;

#[tauri::command]
pub fn map_network_drive(path: String, _letter: String, _persistent: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("net");
        cmd.arg("use");
        if !_letter.is_empty() {
            cmd.arg(format!("{}:", _letter));
        }
        cmd.arg(&path);
        if _persistent {
            cmd.arg("/persistent:yes");
        } else {
            cmd.arg("/persistent:no");
        }

        let output = cmd.output().map_err(|e| e.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).to_string())
        }
    }

    #[cfg(target_os = "linux")]
    {
        // On Linux, "mapping" usually means mounting.
        // This requires sudo or user-mount support (gvfs).
        // Let's try gvfs-mount / gio mount first.
        let output = Command::new("gio")
            .arg("mount")
            .arg(&path)
            .output()
            .map_err(|e| e.to_string())?;

        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).to_string())
        }
    }

    #[cfg(target_os = "macos")]
    {
        // MacOS mount_smbfs / mount_nfs
        let output = Command::new("open")
            .arg(&path) // Usually open smb:// starts the mount process
            .output()
            .map_err(|e| e.to_string())?;

        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).to_string())
        }
    }
}

#[tauri::command]
pub fn disconnect_network_drive(path_or_letter: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("net")
            .arg("use")
            .arg(&path_or_letter)
            .arg("/delete")
            .output()
            .map_err(|e| e.to_string())?;

        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).to_string())
        }
    }

    #[cfg(target_os = "linux")]
    {
        let output = Command::new("gio")
            .arg("mount")
            .arg("-u")
            .arg(&path_or_letter)
            .output()
            .map_err(|e| e.to_string())?;

        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).to_string())
        }
    }

    #[cfg(target_os = "macos")]
    {
        let output = Command::new("diskutil")
            .arg("unmount")
            .arg(&path_or_letter)
            .output()
            .map_err(|e| e.to_string())?;

        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).to_string())
        }
    }
}
