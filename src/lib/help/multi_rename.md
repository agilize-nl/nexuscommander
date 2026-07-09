# Multi-Rename Tool

The Multi-Rename tool allows you to rename hundreds of files at once using powerful rules.

## Using the Tool
1. Select the files you wish to rename.
2. Open the tool with `Ctrl+M` or from the **Files** menu.

## Naming Patterns
You can use variables to build the new filenames:
- `[N]`: Original Filename
- `[E]`: Original Extension
- `[C]`: Counter (e.g., `[C1+1]` starts counting at 1).
- `[YMD]`: Current year, month, or day.
- `[N1-5]`: Extracts characters 1 through 5 from the original name.

## Search and Replace
The tool includes a robust Search and Replace feature, supporting Regular Expressions for complex transformations (like removing brackets, numbering, etc.).

## Live Preview
A split-view table shows you the *Original Name* alongside the *New Name*, updating in real-time as you tweak the rules. Once satisfied, click **Rename** applied the changes permanently.
