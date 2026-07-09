# Working with Archives

NexusCommander treats file archives (`.zip`, `.tar`, `.tar.gz/.tgz`, `.tar.bz2/.tbz2`, `.tar.xz/.txz`, `.7z`, `.rar`) as if they were regular folders.

## Virtual File System
- Press **Enter** on an archive to step inside it.
- You can navigate the internal structure (including subfolders), view files (`F3`), and inspect properties just like normal directories.
- Archives are **read-only**: moving, deleting, renaming or creating folders inside an archive is rejected.

## Copying out of an archive
- While browsing inside an archive, select one or more files/folders and press **F5**, or drag them onto the opposite panel, exactly as you would for a normal copy. The dialog switches to "Extract" wording when the source comes from an archive.
- This works for both single files and whole folders inside the archive; NexusCommander stages the extraction in a temporary directory and copies the result through the normal copy pipeline, so conflict resolution (overwrite/skip/all) and cancellation behave the same as any other copy.

## Extracting (Unpacking) a whole archive file
1. Select the entire archive file itself from its containing folder (i.e. without entering it).
2. Press **Alt+F9** or right-click and choose **Unpack Archive**.
3. Choose the destination directory (defaults to the opposite panel).

> Note: a plain **F5** copy or **F6** move of an archive *file* (not entered) copies/moves the archive file itself, unchanged — it does not unpack it. Use **Alt+F9** to unpack a whole archive.

## Compressing (Packing)
1. Select the files you want to compress.
2. Press **Alt+F5** or right-click and choose **Pack Files**.
3. Specify the name for the target archive and compression method.
