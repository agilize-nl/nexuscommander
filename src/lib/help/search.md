# Finding Files

NexusCommander features a powerful search tool to quickly locate files and text within them.

## Basic Search
1. Open the search dialog by pressing `Alt+F7` or from the **Commands > Search** menu.
2. Enter the filename pattern you are looking for (e.g., `*.txt`).
3. Press **Start**.

## Search Options
- **Start Directory**: Specifies where the search will begin. By default, it uses the current panel's directory.
- **Regular Expressions**: Allows complex pattern matching (e.g., `^report_20\d\d\.pdf$`).
- **Find Text**: Scans the *contents* of files within the directory for a specific string. Useful for finding code snippets or document text.

## Using the Results
Once the search is complete, you can click **Feed to listbox**.
This changes the active panel into a virtual folder containing all the matched search results, allowing you to copy, move, or delete them in batch.
