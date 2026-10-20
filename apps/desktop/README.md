The Origin Story: Scratching a Twin-Panel Itch
I have a confession: I am completely addicted to the orthodox, twin-panel file management workflow. If you are reading this, you probably are too.
My computing habits were forged by absolute legends. I have massive respect and admiration for the titans of this space: Norton Commander, Total Commander, Double Commander, and Gnome Commander. They are brilliant pieces of software that have saved developers and power users millions of clicks over the decades.
But as much as I loved them, I always found myself wanting just a little bit more. Sometimes it was a UI that felt a bit dated, sometimes it was friction in cross-platform behavior, or simply the desire for a more modern aesthetic. Mostly, I wanted to see if I could build a file manager that combined the blazing-fast, bare-metal I/O of traditional desktop apps with the beautiful, reactive, and fluid UI capabilities of modern web frameworks—without the heavy bloat of Electron.
So, I decided to build my own. Welcome to NexusCommander.

🛠️ Under the Hood: The Modern Tech Stack
To achieve that perfect balance of native speed and modern UI, I chose a very specific, lightweight stack:

The Backend (Raw Speed & System Access):
Tauri v2 & Rust (2021): The core of the app. Tauri provides a tiny, secure bridge to the OS, while Rust handles all the heavy lifting memory-safely.
High-Performance File I/O: Powered by jwalk for multithreaded directory size calculations, walkdir for recursive operations, and notify for live file system watching.
Native Integrations: Deep OS integration using dirs for cross-platform path resolution, native archive handling (zip, tar, flate2), and rust-ini to keep configurations portable and classic.

The Frontend (Fluidity & Reactivity):
Svelte 5 & SvelteKit: Leveraging the brand new Svelte Runes ($state, $derived, $effect) for incredibly fast, signal-based DOM updates—crucial for rendering thousands of files without lag.
Vite 6 & Tailwind CSS v4: A lightning-fast build pipeline paired with utility-first styling for a crisp, modern, and easily themeable interface.
Visuals: A custom CSS-variable theme engine for dynamic Light/Dark modes, paired with the clean aesthetics of Lucide Svelte icons.

🌍 Current Status & Roadmap
Right now, NexusCommander is a passion project built primarily on Linux.
Linux (Zorin OS): Native builds are currently tested and working beautifully.
Windows & macOS: Full native builds for these platforms are high on the priority list and will follow soon.
PWA Version: I am also planning a Progressive Web App version for ultimate portability.

🤝 Join the Command Line
I'm building this in the open because I know how passionate the OFM (Orthodox File Manager) community is.
Whether you are a Rustacean, a Svelte wizard, or just a power user with a great idea for a feature, any feedback, pull requests, and suggestions are incredibly welcome. Feel free to open an issue, start a discussion, or fork the repo. Let's build the next generation of dual-pane file management together!
