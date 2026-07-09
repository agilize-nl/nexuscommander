# Custom Columns

Custom Columns allow you to build sophisticated views, displaying exactly the metadata you need.

## The Columns Manager
Access the manager via **Options > Custom Columns**. 
The default view provides Name, Ext, Size, and Date columns.

## Creating a Column
1. Provide a **Caption** for the table header.
2. Set the default **Width** (pixels) and **Align** (Left/Right).
3. The most important field is **Field Contents**.

## Field Contents
You refer to internal metadata through specific syntax tags, such as `[NC().GETFILESIZE]`.
The dialog provides a dropdown list of pre-configured suggestions:
- `FileName`
- `FileExt`
- `FileSize`
- `FileTime` (Modified date)
- `FileAttr` (File Attributes)
- `FileOwner` / `FileGroup`
- `FilePerm` (Permissions like `drwxr-xr-x`)

## Managing Views
You can define multiple sets of Custom Columns (e.g., one for Development, one for General use) and save them to swap out entire views rapidly.
