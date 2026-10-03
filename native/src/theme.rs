pub type Rgba = [u8; 4];

pub const CLOUD: Rgba = [0xFD, 0xFB, 0xF6, 0xFF];
pub const SAND: Rgba = [0xF6, 0xF1, 0xE6, 0xFF];
pub const PALE_SKY: Rgba = [0xE1, 0xEB, 0xED, 0xFF];
pub const SKY: Rgba = [0x89, 0xBC, 0xDD, 0xFF];
pub const SKY_DEEP: Rgba = [0x57, 0xA5, 0xD7, 0xFF];
pub const SEA: Rgba = [0x4C, 0x98, 0xBF, 0xFF];
pub const NAVY: Rgba = [0x0A, 0x2B, 0x65, 0xFF];
pub const SLATE: Rgba = [0x6D, 0x8F, 0xA7, 0xFF];
pub const SALMON: Rgba = [0xD9, 0xBE, 0xB3, 0xFF];
pub const PERIWINKLE: Rgba = [0xB1, 0xB4, 0xC7, 0xFF];
pub const PINK: Rgba = [0xDD, 0x8F, 0x98, 0xFF];
pub const SEAFOAM: Rgba = [0x6F, 0xB7, 0xA8, 0xFF];
pub const SEA_GLASS: Rgba = [0x7F, 0xC4, 0xC4, 0xFF];
pub const AMBER: Rgba = [0xD9, 0xA8, 0x6C, 0xFF];
pub const LIME: Rgba = [0xC8, 0xC7, 0x7A, 0xFF];
pub const TERRACOTTA: Rgba = [0xB8, 0x5C, 0x57, 0xFF];

pub const BACKGROUND: Rgba = SAND;
pub const WALL: Rgba = NAVY;
pub const GRID_LINE: Rgba = with_alpha(SLATE, 0x40);
pub const DOOR_UNLOCKED: Rgba = SEA;
pub const DOOR_LOCKED: Rgba = TERRACOTTA;
pub const PLAYER: Rgba = PINK;
pub const PLAYER_PULSE: Rgba = PINK;

pub const fn with_alpha(color: Rgba, alpha: u8) -> Rgba {
    [color[0], color[1], color[2], alpha]
}

pub fn to_f32(color: Rgba) -> [f32; 4] {
    [
        color[0] as f32 / 255.0,
        color[1] as f32 / 255.0,
        color[2] as f32 / 255.0,
        color[3] as f32 / 255.0,
    ]
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    const CSS: &str = include_str!("../../web/pages/styles.css");

    fn rust_palette() -> BTreeMap<String, String> {
        let source = include_str!("theme.rs");
        let mut palette = BTreeMap::new();
        for line in source.lines() {
            let Some(rest) = line.trim().strip_prefix("pub const ") else {
                continue;
            };
            let Some((name, value)) = rest.split_once(':') else {
                continue;
            };
            let Some((_, rest)) = value.split_once('[') else {
                continue;
            };
            let Some((values, _)) = rest.split_once(']') else {
                continue;
            };
            let parts: Vec<&str> = values.split(',').map(str::trim).collect();
            if parts.len() != 4 {
                continue;
            }
            let mut bytes = [0u8; 4];
            let mut valid = true;
            for (i, part) in parts.iter().enumerate() {
                match part
                    .strip_prefix("0x")
                    .and_then(|h| u8::from_str_radix(h, 16).ok())
                {
                    Some(byte) => bytes[i] = byte,
                    None => valid = false,
                }
            }
            if !valid || bytes[3] != 0xFF {
                continue;
            }
            let key = name.trim().to_lowercase().replace('_', "-");
            let value = format!("#{:02x}{:02x}{:02x}", bytes[0], bytes[1], bytes[2]);
            palette.insert(key, value);
        }
        palette
    }

    fn css_palette() -> BTreeMap<String, String> {
        let mut palette = BTreeMap::new();
        for line in CSS.lines() {
            let Some(rest) = line.trim().strip_prefix("--") else {
                continue;
            };
            let Some((name, value)) = rest.split_once(':') else {
                continue;
            };
            let value = value.trim().trim_end_matches(';').trim();
            let Some(hex) = value.strip_prefix('#') else {
                continue;
            };
            if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
                continue;
            }
            palette.insert(
                name.trim().to_lowercase(),
                format!("#{}", hex.to_lowercase()),
            );
        }
        palette
    }

    #[test]
    fn native_and_web_palettes_match() {
        let native = rust_palette();
        assert!(!native.is_empty(), "no palette constants found in theme.rs");
        assert_eq!(native, css_palette());
    }
}
