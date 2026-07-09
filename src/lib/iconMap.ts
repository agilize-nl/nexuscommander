/**
 * Icon theme mapping utility.
 * Maps file extensions and folder types to icon paths for each theme.
 */

/** Extension → icon SVG filename mapping (shared between Material & Papirus) */
const EXT_MAP: Record<string, string> = {
  // Web
  js: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript",
  html: "html", htm: "html",
  css: "css", scss: "sass", sass: "sass", less: "less",
  json: "json", jsonc: "json", json5: "json",
  xml: "xml", xsl: "xml", xslt: "xml",
  yaml: "yaml", yml: "yaml",
  md: "markdown", mdx: "markdown",
  svg: "image", png: "image", jpg: "image", jpeg: "image", gif: "image",
    bmp: "image", webp: "image", ico: "image", tiff: "image", tif: "image",
  mp4: "video", mkv: "video", avi: "video", mov: "video", wmv: "video",
    webm: "video", flv: "video", m4v: "video",
  mp3: "audio", wav: "audio", flac: "audio", ogg: "audio", aac: "audio",
    wma: "audio", m4a: "audio", opus: "audio",
  pdf: "pdf",

  // Archives
  zip: "zip", rar: "zip", "7z": "zip", tar: "zip", gz: "zip",
    bz2: "zip", xz: "zip", zst: "zip", tgz: "zip",

  // Languages
  py: "python", pyw: "python", pyi: "python",
  rs: "rust",
  c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  java: "java", jar: "java", class: "java",
  go: "go",
  rb: "ruby", gemspec: "ruby",
  php: "php",
  swift: "swift",
  kt: "kotlin", kts: "kotlin",
  scala: "scala", sc: "scala",
  lua: "lua",
  pl: "perl", pm: "perl",
  r: "r", R: "r",
  jl: "julia",
  ex: "elixir", exs: "elixir",
  erl: "erlang", hrl: "erlang",
  hs: "haskell", lhs: "haskell",
  clj: "clojure", cljs: "clojure", cljc: "clojure",
  asm: "asm", s: "asm",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell",

  // Frameworks
  svelte: "svelte",
  jsx: "react",
  vue: "vue",

  // Config & Build
  toml: "config", ini: "config", cfg: "config", conf: "config",
    env: "config", properties: "config",
  dockerfile: "docker",
  makefile: "makefile",
  cmake: "cmake",

  // Fonts
  ttf: "font", otf: "font", woff: "font", woff2: "font",

  // Data
  sql: "database", db: "database", sqlite: "database", sqlite3: "database",

  // Security
  pem: "key", key: "key", pub: "key",
  crt: "certificate", cer: "certificate",

  // Docs
  log: "log", txt: "document",
  doc: "document", docx: "document", odt: "document",
  xls: "document", xlsx: "document", csv: "document",

  // Git
  gitignore: "git", gitattributes: "git", gitmodules: "git",

  // Lock files
  lock: "lock",

  // Package managers
  npmrc: "npm",

  // Misc
  graphql: "graphql", gql: "graphql",
  eslintrc: "eslint",
  prettierrc: "prettier",
  editorconfig: "editorconfig",
};

/** Special full-filename matches */
const NAME_MAP: Record<string, string> = {
  "readme.md": "readme",
  "readme.txt": "readme",
  "readme": "readme",
  "license": "license",
  "license.md": "license",
  "license.txt": "license",
  "dockerfile": "docker",
  "docker-compose.yml": "docker",
  "docker-compose.yaml": "docker",
  "makefile": "makefile",
  "cmakelists.txt": "cmake",
  ".gitignore": "git",
  ".gitattributes": "git",
  ".gitmodules": "git",
  ".eslintrc.json": "eslint",
  ".eslintrc.js": "eslint",
  ".prettierrc": "prettier",
  ".editorconfig": "editorconfig",
  "package.json": "npm",
  "package-lock.json": "npm",
  "yarn.lock": "yarn",
  "cargo.toml": "rust",
  "cargo.lock": "rust",
  "go.mod": "go",
  "go.sum": "go",
  "tsconfig.json": "typescript",
  "webpack.config.js": "webpack",
  "vite.config.ts": "config",
  "vite.config.js": "config",
  "svelte.config.js": "svelte",
};

/**
 * Get the icon path for a file or directory.
 * 
 * @param name - File name (e.g. "main.rs")
 * @param ext - File extension without dot (e.g. "rs")
 * @param isDir - Whether the entry is a directory
 * @param theme - Icon theme ("material" | "papirus" | "lucide")
 * @returns The path to the SVG icon, or null for the "lucide" theme
 */
export function getFileIconPath(
  name: string,
  ext: string,
  isDir: boolean,
  theme: string
): string | null {
  if (theme === "lucide") return null; // Handled by Lucide components

  const basePath = `/icons/${theme}`;

  if (isDir) {
    return `${basePath}/folder.svg`;
  }

  // Check full filename first
  const lower = name.toLowerCase();
  if (NAME_MAP[lower]) {
    return `${basePath}/${NAME_MAP[lower]}.svg`;
  }

  // Check extension
  const lowerExt = ext.toLowerCase();
  if (EXT_MAP[lowerExt]) {
    return `${basePath}/${EXT_MAP[lowerExt]}.svg`;
  }

  // Fallback to generic file
  return `${basePath}/file.svg`;
}

/**
 * Get the Lucide icon name for a file or directory.
 * Used when theme is "lucide".
 */
export function getLucideIconName(
  ext: string,
  isDir: boolean
): string {
  if (isDir) return "Folder";

  const lowerExt = ext.toLowerCase();

  // Map extensions to Lucide icon names
  const lucideMap: Record<string, string> = {
    // Code
    js: "FileCode", mjs: "FileCode", cjs: "FileCode",
    ts: "FileCode", tsx: "FileCode",
    py: "FileCode", rs: "FileCode",
    c: "FileCode", cpp: "FileCode", h: "FileCode",
    java: "FileCode", go: "FileCode", rb: "FileCode",
    php: "FileCode", swift: "FileCode", kt: "FileCode",
    lua: "FileCode", pl: "FileCode", sh: "FileCode",
    svelte: "FileCode", jsx: "FileCode", vue: "FileCode",
    html: "FileCode", css: "FileCode", scss: "FileCode",

    // Data
    json: "FileJson", jsonc: "FileJson",
    xml: "FileCode", yaml: "FileCode", yml: "FileCode",
    csv: "FileSpreadsheet", xls: "FileSpreadsheet", xlsx: "FileSpreadsheet",
    sql: "Database",

    // Documents
    md: "FileText", txt: "FileText",
    pdf: "FileText",
    doc: "FileText", docx: "FileText",
    log: "FileText",

    // Media
    png: "Image", jpg: "Image", jpeg: "Image", gif: "Image",
    svg: "Image", webp: "Image", bmp: "Image", ico: "Image",
    mp4: "Film", mkv: "Film", avi: "Film", mov: "Film",
    mp3: "Music", wav: "Music", flac: "Music", ogg: "Music",
    aac: "Music", m4a: "Music",

    // Archives
    zip: "FileArchive", rar: "FileArchive", "7z": "FileArchive",
    tar: "FileArchive", gz: "FileArchive",

    // Config
    toml: "Settings", ini: "Settings", cfg: "Settings",
    env: "Settings", conf: "Settings",

    // Security
    pem: "Key", key: "Key", pub: "Key",
    crt: "ShieldCheck", cer: "ShieldCheck",

    // Fonts
    ttf: "Type", otf: "Type", woff: "Type",

    // Lock
    lock: "Lock",
  };

  return lucideMap[lowerExt] || "File";
}
