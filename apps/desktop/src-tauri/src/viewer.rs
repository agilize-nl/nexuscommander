use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ViewerMode {
    Text,
    Hex,
    Image,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewerContent {
    pub mode: ViewerMode,
    pub file_name: String,
    pub file_size: u64,
    pub text: Option<String>,
    pub hex_lines: Option<Vec<String>>,
    pub image_data: Option<String>,
    pub mime_type: Option<String>,
    pub encoding: Option<String>,
}

#[allow(clippy::identity_op)]
mod limits {
    pub const MAX_TEXT_SIZE: u64 = 10 * 1024 * 1024; // 10 MB
    pub const MAX_HEX_SIZE: u64 = 1 * 1024 * 1024; // 1 MB display for hex
    pub const MAX_IMAGE_SIZE: u64 = 50 * 1024 * 1024; // 50 MB
}
use limits::{MAX_HEX_SIZE, MAX_IMAGE_SIZE, MAX_TEXT_SIZE};

const TABLE_CP437: [char; 128] = [
    '\u{00C7}', '\u{00FC}', '\u{00E9}', '\u{00E2}', '\u{00E4}', '\u{00E0}', '\u{00E5}', '\u{00E7}',
    '\u{00EA}', '\u{00EB}', '\u{00E8}', '\u{00EF}', '\u{00EE}', '\u{00EC}', '\u{00C4}', '\u{00C5}',
    '\u{00C9}', '\u{00E6}', '\u{00C6}', '\u{00F4}', '\u{00F6}', '\u{00F2}', '\u{00FB}', '\u{00F9}',
    '\u{00FF}', '\u{00D6}', '\u{00DC}', '\u{00A2}', '\u{00A3}', '\u{00A5}', '\u{20A7}', '\u{0192}',
    '\u{00E1}', '\u{00ED}', '\u{00F3}', '\u{00FA}', '\u{00F1}', '\u{00D1}', '\u{00AA}', '\u{00BA}',
    '\u{00BF}', '\u{2310}', '\u{00AC}', '\u{00BD}', '\u{00BC}', '\u{00A1}', '\u{00AB}', '\u{00BB}',
    '\u{2591}', '\u{2592}', '\u{2593}', '\u{2502}', '\u{2524}', '\u{2561}', '\u{2562}', '\u{2556}',
    '\u{2555}', '\u{2563}', '\u{2551}', '\u{2557}', '\u{255D}', '\u{255C}', '\u{255B}', '\u{2510}',
    '\u{2514}', '\u{2534}', '\u{252C}', '\u{251C}', '\u{2500}', '\u{253C}', '\u{255E}', '\u{255F}',
    '\u{255A}', '\u{2554}', '\u{2569}', '\u{2566}', '\u{2560}', '\u{2550}', '\u{256C}', '\u{2567}',
    '\u{2568}', '\u{2564}', '\u{2565}', '\u{2559}', '\u{2558}', '\u{2552}', '\u{2553}', '\u{256B}',
    '\u{256A}', '\u{2518}', '\u{250C}', '\u{2588}', '\u{2584}', '\u{258C}', '\u{2590}', '\u{2580}',
    '\u{03B1}', '\u{00DF}', '\u{0393}', '\u{03C0}', '\u{03A3}', '\u{03C3}', '\u{00B5}', '\u{03C4}',
    '\u{03A6}', '\u{0398}', '\u{03A9}', '\u{03B4}', '\u{221E}', '\u{03C6}', '\u{03B5}', '\u{2229}',
    '\u{2261}', '\u{00B1}', '\u{2265}', '\u{2264}', '\u{2320}', '\u{2321}', '\u{00F7}', '\u{2248}',
    '\u{00B0}', '\u{2219}', '\u{00B7}', '\u{221A}', '\u{207F}', '\u{00B2}', '\u{25A0}', '\u{00A0}',
];

const TABLE_CP850: [char; 128] = [
    '\u{00C7}', '\u{00FC}', '\u{00E9}', '\u{00E2}', '\u{00E4}', '\u{00E0}', '\u{00E5}', '\u{00E7}',
    '\u{00EA}', '\u{00EB}', '\u{00E8}', '\u{00EF}', '\u{00EE}', '\u{00EC}', '\u{00C4}', '\u{00C5}',
    '\u{00C9}', '\u{00E6}', '\u{00C6}', '\u{00F4}', '\u{00F6}', '\u{00F2}', '\u{00FB}', '\u{00F9}',
    '\u{00FF}', '\u{00D6}', '\u{00DC}', '\u{00F8}', '\u{00A3}', '\u{00D8}', '\u{00D7}', '\u{0192}',
    '\u{00E1}', '\u{00ED}', '\u{00F3}', '\u{00FA}', '\u{00F1}', '\u{00D1}', '\u{00AA}', '\u{00BA}',
    '\u{00BF}', '\u{00AE}', '\u{00AC}', '\u{00BD}', '\u{00BC}', '\u{00A1}', '\u{00AB}', '\u{00BB}',
    '\u{2591}', '\u{2592}', '\u{2593}', '\u{2502}', '\u{2524}', '\u{00C1}', '\u{00C2}', '\u{00C0}',
    '\u{00A9}', '\u{2563}', '\u{2551}', '\u{2557}', '\u{255D}', '\u{00A2}', '\u{00A5}', '\u{2510}',
    '\u{2514}', '\u{2534}', '\u{252C}', '\u{251C}', '\u{2500}', '\u{253C}', '\u{00E3}', '\u{00C3}',
    '\u{255A}', '\u{2554}', '\u{2569}', '\u{2566}', '\u{2560}', '\u{2550}', '\u{256C}', '\u{00A4}',
    '\u{00F0}', '\u{00D0}', '\u{00CA}', '\u{00CB}', '\u{00C8}', '\u{0131}', '\u{00CD}', '\u{00CE}',
    '\u{00CF}', '\u{2518}', '\u{250C}', '\u{2588}', '\u{2584}', '\u{00A6}', '\u{00CC}', '\u{2580}',
    '\u{00D3}', '\u{00DF}', '\u{00D4}', '\u{00D2}', '\u{00F5}', '\u{00D5}', '\u{00B5}', '\u{00FE}',
    '\u{00DE}', '\u{00DA}', '\u{00DB}', '\u{00D9}', '\u{00FD}', '\u{00DD}', '\u{00AF}', '\u{00B4}',
    '\u{00AD}', '\u{00B1}', '\u{2017}', '\u{00BE}', '\u{00B6}', '\u{00A7}', '\u{00F7}', '\u{00B8}',
    '\u{00B0}', '\u{00A8}', '\u{00B7}', '\u{00B9}', '\u{00B3}', '\u{00B2}', '\u{25A0}', '\u{00A0}',
];

const TABLE_CP852: [char; 128] = [
    '\u{00C7}', '\u{00FC}', '\u{00E9}', '\u{00E2}', '\u{00E4}', '\u{016F}', '\u{0107}', '\u{00E7}',
    '\u{0142}', '\u{00EB}', '\u{0150}', '\u{0151}', '\u{00EE}', '\u{0179}', '\u{00C4}', '\u{0106}',
    '\u{00C9}', '\u{0139}', '\u{013A}', '\u{00F4}', '\u{00F6}', '\u{013D}', '\u{013E}', '\u{015A}',
    '\u{015B}', '\u{00D6}', '\u{00DC}', '\u{0164}', '\u{0165}', '\u{0141}', '\u{00D7}', '\u{010D}',
    '\u{00E1}', '\u{00ED}', '\u{00F3}', '\u{00FA}', '\u{0104}', '\u{0105}', '\u{017D}', '\u{017E}',
    '\u{0118}', '\u{0119}', '\u{00AC}', '\u{017A}', '\u{010C}', '\u{015F}', '\u{00AB}', '\u{00BB}',
    '\u{2591}', '\u{2592}', '\u{2593}', '\u{2502}', '\u{2524}', '\u{00C1}', '\u{00C2}', '\u{011A}',
    '\u{015E}', '\u{2563}', '\u{2551}', '\u{2557}', '\u{255D}', '\u{017B}', '\u{017C}', '\u{2510}',
    '\u{2514}', '\u{2534}', '\u{252C}', '\u{251C}', '\u{2500}', '\u{253C}', '\u{0102}', '\u{0103}',
    '\u{255A}', '\u{2554}', '\u{2569}', '\u{2566}', '\u{2560}', '\u{2550}', '\u{256C}', '\u{00A4}',
    '\u{0111}', '\u{0110}', '\u{010E}', '\u{00CB}', '\u{010F}', '\u{0147}', '\u{00CD}', '\u{00CE}',
    '\u{011B}', '\u{2518}', '\u{250C}', '\u{2588}', '\u{2584}', '\u{0162}', '\u{016E}', '\u{2580}',
    '\u{00D3}', '\u{00DF}', '\u{00D4}', '\u{0143}', '\u{0144}', '\u{0148}', '\u{0160}', '\u{0161}',
    '\u{0154}', '\u{00DA}', '\u{0155}', '\u{0170}', '\u{00FD}', '\u{00DD}', '\u{0163}', '\u{00B4}',
    '\u{00AD}', '\u{02DD}', '\u{02DB}', '\u{02C7}', '\u{02D8}', '\u{00A7}', '\u{00F7}', '\u{00B8}',
    '\u{00B0}', '\u{00A8}', '\u{02D9}', '\u{0171}', '\u{0158}', '\u{0159}', '\u{25A0}', '\u{00A0}',
];

const TABLE_KOI8_RU: [char; 128] = [
    '\u{2500}', '\u{2502}', '\u{250C}', '\u{2510}', '\u{2514}', '\u{2518}', '\u{251C}', '\u{2524}',
    '\u{252C}', '\u{2534}', '\u{253C}', '\u{2580}', '\u{2584}', '\u{2588}', '\u{258C}', '\u{2590}',
    '\u{2591}', '\u{2592}', '\u{2593}', '\u{2320}', '\u{25A0}', '\u{2219}', '\u{221A}', '\u{2248}',
    '\u{2264}', '\u{2265}', '\u{00A0}', '\u{2321}', '\u{00B0}', '\u{00B2}', '\u{00B7}', '\u{00F7}',
    '\u{2550}', '\u{2551}', '\u{2552}', '\u{0451}', '\u{0454}', '\u{2554}', '\u{0456}', '\u{0457}',
    '\u{2557}', '\u{2558}', '\u{2559}', '\u{255A}', '\u{255B}', '\u{0491}', '\u{045E}', '\u{255E}',
    '\u{255F}', '\u{2560}', '\u{2561}', '\u{0401}', '\u{0404}', '\u{2563}', '\u{0406}', '\u{0407}',
    '\u{2566}', '\u{2567}', '\u{2568}', '\u{2569}', '\u{256A}', '\u{0490}', '\u{040E}', '\u{00A9}',
    '\u{044E}', '\u{0430}', '\u{0431}', '\u{0446}', '\u{0434}', '\u{0435}', '\u{0444}', '\u{0433}',
    '\u{0445}', '\u{0438}', '\u{0439}', '\u{043A}', '\u{043B}', '\u{043C}', '\u{043D}', '\u{043E}',
    '\u{043F}', '\u{044F}', '\u{0440}', '\u{0441}', '\u{0442}', '\u{0443}', '\u{0436}', '\u{0432}',
    '\u{044C}', '\u{044B}', '\u{0437}', '\u{0448}', '\u{044D}', '\u{0449}', '\u{0447}', '\u{044A}',
    '\u{042E}', '\u{0410}', '\u{0411}', '\u{0426}', '\u{0414}', '\u{0415}', '\u{0424}', '\u{0413}',
    '\u{0425}', '\u{0418}', '\u{0419}', '\u{041A}', '\u{041B}', '\u{041C}', '\u{041D}', '\u{041E}',
    '\u{041F}', '\u{042F}', '\u{0420}', '\u{0421}', '\u{0422}', '\u{0423}', '\u{0416}', '\u{0412}',
    '\u{042C}', '\u{042B}', '\u{0417}', '\u{0428}', '\u{042D}', '\u{0429}', '\u{0427}', '\u{042A}',
];

fn decode_single_byte(bytes: &[u8], table: &[char; 128]) -> String {
    bytes
        .iter()
        .map(|&b| {
            if b < 0x80 {
                b as char
            } else {
                table[(b - 0x80) as usize]
            }
        })
        .collect()
}

fn decode_utf16(bytes: &[u8], le: bool) -> String {
    let has_bom =
        (le && bytes.starts_with(&[0xFF, 0xFE])) || (!le && bytes.starts_with(&[0xFE, 0xFF]));
    let slice = if has_bom { &bytes[2..] } else { bytes };

    let u16s: Vec<u16> = slice
        .chunks_exact(2)
        .map(|c| {
            if le {
                u16::from_le_bytes([c[0], c[1]])
            } else {
                u16::from_be_bytes([c[0], c[1]])
            }
        })
        .collect();

    char::decode_utf16(u16s)
        .map(|r| r.unwrap_or('\u{FFFD}'))
        .collect()
}

fn decode_utf32(bytes: &[u8], le: bool) -> String {
    let has_bom = (le && bytes.starts_with(&[0xFF, 0xFE, 0x00, 0x00]))
        || (!le && bytes.starts_with(&[0x00, 0x00, 0xFE, 0xFF]));
    let slice = if has_bom { &bytes[4..] } else { bytes };

    slice
        .chunks_exact(4)
        .map(|c| {
            let val = if le {
                u32::from_le_bytes([c[0], c[1], c[2], c[3]])
            } else {
                u32::from_be_bytes([c[0], c[1], c[2], c[3]])
            };
            char::from_u32(val).unwrap_or('\u{FFFD}')
        })
        .collect()
}

/// Decode arbitrary bytes into UTF-8 text given an encoding name.
/// Returns (decoded_string, canonical_encoding_name).
pub fn decode_bytes(bytes: &[u8], requested_encoding: &str) -> (String, String) {
    let norm = requested_encoding.trim();

    if norm.eq_ignore_ascii_case("Auto-detect") || norm.is_empty() {
        // 1. Sniff BOM
        if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
            return (
                String::from_utf8_lossy(&bytes[3..]).into_owned(),
                "UTF-8BOM".to_string(),
            );
        }
        if bytes.starts_with(&[0xFF, 0xFE, 0x00, 0x00]) {
            return (decode_utf32(bytes, true), "UTF-32LE".to_string());
        }
        if bytes.starts_with(&[0x00, 0x00, 0xFE, 0xFF]) {
            return (decode_utf32(bytes, false), "UTF-32BE".to_string());
        }
        if bytes.starts_with(&[0xFF, 0xFE]) {
            return (decode_utf16(bytes, true), "UTF-16LE".to_string());
        }
        if bytes.starts_with(&[0xFE, 0xFF]) {
            return (decode_utf16(bytes, false), "UTF-16BE".to_string());
        }

        // 2. UTF-8 check
        if std::str::from_utf8(bytes).is_ok() {
            return (
                String::from_utf8_lossy(bytes).into_owned(),
                "UTF-8".to_string(),
            );
        }

        // 3. Fallback to ANSI (CP1252) so every file can be inspected
        let (cow, _, _) = encoding_rs::WINDOWS_1252.decode(bytes);
        return (cow.into_owned(), "ANSI".to_string());
    }

    let enc_upper = norm.to_ascii_uppercase().replace(['-', '_'], "");

    match enc_upper.as_str() {
        "UTF8" => (
            String::from_utf8_lossy(bytes).into_owned(),
            "UTF-8".to_string(),
        ),
        "UTF8BOM" => {
            let b = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
                &bytes[3..]
            } else {
                bytes
            };
            (
                String::from_utf8_lossy(b).into_owned(),
                "UTF-8BOM".to_string(),
            )
        }
        "ANSI" => {
            let (cow, _, _) = encoding_rs::WINDOWS_1252.decode(bytes);
            (cow.into_owned(), "ANSI".to_string())
        }
        "OEM" => (decode_single_byte(bytes, &TABLE_CP437), "OEM".to_string()),
        "CP437" => (decode_single_byte(bytes, &TABLE_CP437), "CP437".to_string()),
        "CP850" => (decode_single_byte(bytes, &TABLE_CP850), "CP850".to_string()),
        "CP852" => (decode_single_byte(bytes, &TABLE_CP852), "CP852".to_string()),
        "KOI8RU" => (
            decode_single_byte(bytes, &TABLE_KOI8_RU),
            "KOI8-RU".to_string(),
        ),
        "ISO88591" => {
            let s: String = bytes.iter().map(|&b| b as char).collect();
            (s, "ISO-8859-1".to_string())
        }
        "UCS2LE" | "UTF16LE" => (decode_utf16(bytes, true), "UTF-16LE".to_string()),
        "UCS2BE" | "UTF16BE" => (decode_utf16(bytes, false), "UTF-16BE".to_string()),
        "UTF32LE" => (decode_utf32(bytes, true), "UTF-32LE".to_string()),
        "UTF32BE" => (decode_utf32(bytes, false), "UTF-32BE".to_string()),
        "CP1250" => {
            let (cow, _, _) = encoding_rs::WINDOWS_1250.decode(bytes);
            (cow.into_owned(), "CP1250".to_string())
        }
        "CP1251" => {
            let (cow, _, _) = encoding_rs::WINDOWS_1251.decode(bytes);
            (cow.into_owned(), "CP1251".to_string())
        }
        "CP1252" => {
            let (cow, _, _) = encoding_rs::WINDOWS_1252.decode(bytes);
            (cow.into_owned(), "CP1252".to_string())
        }
        "CP1253" => {
            let (cow, _, _) = encoding_rs::WINDOWS_1253.decode(bytes);
            (cow.into_owned(), "CP1253".to_string())
        }
        "CP1254" => {
            let (cow, _, _) = encoding_rs::WINDOWS_1254.decode(bytes);
            (cow.into_owned(), "CP1254".to_string())
        }
        "CP1255" => {
            let (cow, _, _) = encoding_rs::WINDOWS_1255.decode(bytes);
            (cow.into_owned(), "CP1255".to_string())
        }
        "CP1256" => {
            let (cow, _, _) = encoding_rs::WINDOWS_1256.decode(bytes);
            (cow.into_owned(), "CP1256".to_string())
        }
        "CP1257" => {
            let (cow, _, _) = encoding_rs::WINDOWS_1257.decode(bytes);
            (cow.into_owned(), "CP1257".to_string())
        }
        "CP1258" => {
            let (cow, _, _) = encoding_rs::WINDOWS_1258.decode(bytes);
            (cow.into_owned(), "CP1258".to_string())
        }
        "CP866" => {
            let (cow, _, _) = encoding_rs::IBM866.decode(bytes);
            (cow.into_owned(), "CP866".to_string())
        }
        "CP874" => {
            let (cow, _, _) = encoding_rs::WINDOWS_874.decode(bytes);
            (cow.into_owned(), "CP874".to_string())
        }
        "CP932" => {
            let (cow, _, _) = encoding_rs::SHIFT_JIS.decode(bytes);
            (cow.into_owned(), "CP932".to_string())
        }
        "CP936" => {
            let (cow, _, _) = encoding_rs::GBK.decode(bytes);
            (cow.into_owned(), "CP936".to_string())
        }
        "CP949" => {
            let (cow, _, _) = encoding_rs::EUC_KR.decode(bytes);
            (cow.into_owned(), "CP949".to_string())
        }
        "CP950" => {
            let (cow, _, _) = encoding_rs::BIG5.decode(bytes);
            (cow.into_owned(), "CP950".to_string())
        }
        "ISO88592" => {
            let (cow, _, _) = encoding_rs::ISO_8859_2.decode(bytes);
            (cow.into_owned(), "ISO-8859-2".to_string())
        }
        "KOI8R" => {
            let (cow, _, _) = encoding_rs::KOI8_R.decode(bytes);
            (cow.into_owned(), "KOI8-R".to_string())
        }
        "KOI8U" => {
            let (cow, _, _) = encoding_rs::KOI8_U.decode(bytes);
            (cow.into_owned(), "KOI8-U".to_string())
        }
        _ => (
            String::from_utf8_lossy(bytes).into_owned(),
            norm.to_string(),
        ),
    }
}

/// Detect the viewer mode based on file extension.
fn detect_mode(path: &str) -> ViewerMode {
    let lower = path.to_lowercase();
    let ext = Path::new(&lower)
        .extension()
        .map(|e| e.to_str().unwrap_or(""))
        .unwrap_or("");

    match ext {
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" | "svg" | "ico" | "avif" => {
            ViewerMode::Image
        }
        "txt" | "md" | "rs" | "py" | "js" | "ts" | "svelte" | "html" | "css" | "json" | "toml"
        | "yaml" | "yml" | "xml" | "csv" | "log" | "conf" | "cfg" | "ini" | "sh" | "bash"
        | "zsh" | "fish" | "ps1" | "bat" | "cmd" | "c" | "cpp" | "h" | "hpp" | "java" | "go"
        | "rb" | "php" | "sql" | "lua" | "vim" | "el" | "lisp" | "hs" | "ml" | "ex" | "exs"
        | "erl" | "clj" | "scala" | "kt" | "swift" | "r" | "pl" | "pm" | "diff" | "patch"
        | "makefile" | "cmake" | "dockerfile" | "gitignore" | "editorconfig" | "env" | "lock" => {
            ViewerMode::Text
        }
        _ => ViewerMode::Hex,
    }
}

fn get_mime_type(path: &str) -> String {
    let ext = Path::new(path)
        .extension()
        .map(|e| e.to_str().unwrap_or(""))
        .unwrap_or("");

    match ext.to_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// Read a file for viewing.
pub fn read_file_for_viewer(
    path: &str,
    requested_encoding: Option<&str>,
) -> Result<ViewerContent, String> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(format!("File does not exist: {}", path));
    }
    if p.is_dir() {
        return Err("Cannot view a directory".to_string());
    }

    let metadata = p
        .metadata()
        .map_err(|e| format!("Failed to read metadata: {}", e))?;
    // A FIFO blocks `open` until a writer appears — on the thread serving
    // this command — and a device such as /dev/zero never reaches EOF.
    // Neither has content a viewer can show.
    if !metadata.is_file() {
        return Err(format!("Not a regular file: {}", path));
    }
    let file_size = metadata.len();
    let file_name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());

    // If it is an image and no specific text encoding was explicitly requested, show as image
    let detected = detect_mode(path);
    if matches!(detected, ViewerMode::Image) && requested_encoding.is_none() {
        if file_size > MAX_IMAGE_SIZE {
            return Ok(ViewerContent {
                mode: ViewerMode::Unsupported,
                file_name,
                file_size,
                text: Some("Image too large to display.".to_string()),
                hex_lines: None,
                image_data: None,
                mime_type: None,
                encoding: None,
            });
        }

        let mime = get_mime_type(path);
        return Ok(ViewerContent {
            mode: ViewerMode::Image,
            file_name,
            file_size,
            text: None,
            hex_lines: None,
            image_data: None,
            mime_type: Some(mime),
            encoding: None,
        });
    }

    if file_size > MAX_TEXT_SIZE {
        return Ok(ViewerContent {
            mode: ViewerMode::Unsupported,
            file_name,
            file_size,
            text: Some(format!(
                "File too large for viewer ({} bytes). Max: {} bytes.",
                file_size, MAX_TEXT_SIZE
            )),
            hex_lines: None,
            image_data: None,
            mime_type: None,
            encoding: None,
        });
    }

    let mut file = fs::File::open(path).map_err(|e| format!("Failed to open file: {}", e))?;
    let mut buffer = vec![0u8; file_size as usize];
    file.read_exact(&mut buffer)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    // Generate hex dump lines up to MAX_HEX_SIZE
    let hex_limit = std::cmp::min(buffer.len(), MAX_HEX_SIZE as usize);
    let hex_lines = generate_hex_dump(&buffer[..hex_limit]);

    // Decode text using requested encoding or Auto-detect
    let enc_to_use = requested_encoding.unwrap_or("Auto-detect");
    let (decoded_text, actual_encoding) = decode_bytes(&buffer, enc_to_use);

    // Determine default display mode:
    // 1. If user explicitly requested an encoding, prioritize Text mode.
    // 2. If extension is a known text extension or buffer looks like text, use Text mode.
    // 3. Otherwise default to Hex, but with text ready so one-click toggle works instantly.
    let mode = if requested_encoding.is_some()
        || matches!(detected, ViewerMode::Text)
        || is_likely_text(&buffer)
    {
        ViewerMode::Text
    } else {
        ViewerMode::Hex
    };

    Ok(ViewerContent {
        mode,
        file_name,
        file_size,
        text: Some(decoded_text),
        hex_lines: Some(hex_lines),
        image_data: None,
        mime_type: None,
        encoding: Some(actual_encoding),
    })
}

/// Generate hex dump lines from bytes.
fn generate_hex_dump(data: &[u8]) -> Vec<String> {
    let mut lines = Vec::new();
    let bytes_per_line = 16;

    for (i, chunk) in data.chunks(bytes_per_line).enumerate() {
        let offset = i * bytes_per_line;
        let hex_part: String = chunk
            .iter()
            .enumerate()
            .map(|(j, b)| {
                let sep = if j == 8 { "  " } else { " " };
                format!("{}{:02X}", sep, b)
            })
            .collect();

        let padding = if chunk.len() < bytes_per_line {
            let missing = bytes_per_line - chunk.len();
            let extra_gap = if chunk.len() <= 8 { "  " } else { "" };
            format!("{}{}", " ".repeat(missing * 3), extra_gap)
        } else {
            String::new()
        };

        let ascii_part: String = chunk
            .iter()
            .map(|b| {
                if *b >= 0x20 && *b <= 0x7E {
                    *b as char
                } else {
                    '·'
                }
            })
            .collect();

        lines.push(format!(
            "{:08X} {}{}  │{}│",
            offset, hex_part, padding, ascii_part
        ));
    }

    lines
}

/// Check if a buffer is likely text.
fn is_likely_text(buffer: &[u8]) -> bool {
    if buffer.is_empty() {
        return true;
    }
    if buffer.starts_with(&[0xEF, 0xBB, 0xBF])
        || buffer.starts_with(&[0xFF, 0xFE])
        || buffer.starts_with(&[0xFE, 0xFF])
    {
        return true;
    }
    let check_len = std::cmp::min(buffer.len(), 8192);
    let null_count = buffer[..check_len].iter().filter(|&&b| b == 0).count();
    null_count == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_all_encodings_supported() {
        let encodings = [
            "Auto-detect",
            "UTF-8",
            "UTF-8BOM",
            "ANSI",
            "OEM",
            "CP1250",
            "CP1251",
            "CP1252",
            "CP1253",
            "CP1254",
            "CP1255",
            "CP1256",
            "CP1257",
            "CP1258",
            "CP437",
            "CP850",
            "CP852",
            "CP866",
            "CP874",
            "CP932",
            "CP936",
            "CP949",
            "CP950",
            "ISO-8859-1",
            "ISO-8859-2",
            "KOI8-R",
            "KOI8-U",
            "KOI8-RU",
            "UCS-2LE",
            "UCS-2BE",
            "UTF-16LE",
            "UTF-16BE",
            "UTF-32LE",
            "UTF-32BE",
        ];

        let sample = b"Hello, World! \xC4\x8C \xC5\xBC";
        for enc in encodings {
            let (decoded, actual) = decode_bytes(sample, enc);
            assert!(!decoded.is_empty(), "Failed on encoding: {}", enc);
            assert!(!actual.is_empty(), "Missing actual name for: {}", enc);
        }
    }

    #[test]
    fn test_bom_detection() {
        let utf8_bom = [0xEF, 0xBB, 0xBF, b'A', b'B', b'C'];
        let (text, enc) = decode_bytes(&utf8_bom, "Auto-detect");
        assert_eq!(text, "ABC");
        assert_eq!(enc, "UTF-8BOM");

        let utf16le_bom = [0xFF, 0xFE, b'A', 0x00, b'B', 0x00];
        let (text, enc) = decode_bytes(&utf16le_bom, "Auto-detect");
        assert_eq!(text, "AB");
        assert_eq!(enc, "UTF-16LE");
    }

    #[test]
    fn test_cp1250_specific() {
        // CP1250 byte 0xB3 is 'ł', 0xBF is 'ż'
        let bytes = [0xB3, 0xBF];
        let (text, enc) = decode_bytes(&bytes, "CP1250");
        assert_eq!(enc, "CP1250");
        assert_eq!(text, "łż");
    }

    #[test]
    fn test_cp437_box_drawing() {
        // CP437 byte 0xC9 is '╔', 0xBB is '╗', 0xCD is '═'
        let bytes = [0xC9, 0xCD, 0xBB];
        let (text, enc) = decode_bytes(&bytes, "CP437");
        assert_eq!(enc, "CP437");
        assert_eq!(text, "╔═╗");
    }

    #[test]
    fn test_binary_file_as_text_not_crashing() {
        // Like the WordPerfect file header: WPC#\0\1\xFF
        let bytes = b"WPC#\x00\x01\xFF\xFE";
        let (text, _) = decode_bytes(bytes, "CP1250");
        assert!(text.contains("WPC#"));
    }
}
