//! Regenerates `assets/rocky.ico` from `assets/rocky-mark.png`, the square
//! master cropped from the logo. To change the icon, replace the master, then:
//!
//!     cargo run -p rocky-desk --example make_icon
//!
//! The ico holds 16, 32, and 48 as 32-bit DIBs and 256 as PNG, the layout
//! Windows reads for the exe, window, taskbar, and toast icons.

use image::imageops::{self, FilterType};
use image::{ImageFormat, RgbaImage};
use std::io::Cursor;
use std::path::Path;

const SIZES: [u32; 4] = [16, 32, 48, 256];

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets");
    let mark = image::open(dir.join("rocky-mark.png"))
        .expect("read assets/rocky-mark.png")
        .to_rgba8();
    assert_eq!(mark.width(), mark.height(), "the master must be square");
    let frames: Vec<Vec<u8>> = SIZES
        .iter()
        .map(|&size| {
            let icon = resize_premultiplied(&mark, size);
            if size == 256 { png(&icon) } else { dib(&icon) }
        })
        .collect();
    let ico = build_ico(&frames);
    std::fs::write(dir.join("rocky.ico"), &ico).expect("write assets/rocky.ico");
    println!("wrote assets/rocky.ico ({} bytes)", ico.len());
}

/// Lanczos in premultiplied alpha, so transparent pixels never bleed dark
/// into the anti-aliased edge.
fn resize_premultiplied(img: &RgbaImage, size: u32) -> RgbaImage {
    let mut pre = img.clone();
    for p in pre.pixels_mut() {
        let a = u32::from(p[3]);
        for c in &mut p.0[..3] {
            *c = ((u32::from(*c) * a + 127) / 255) as u8;
        }
    }
    let mut out = imageops::resize(&pre, size, size, FilterType::Lanczos3);
    for p in out.pixels_mut() {
        let a = u32::from(p[3]);
        for c in &mut p.0[..3] {
            // Lanczos can ring a channel above its alpha; clamp before dividing.
            let v = u32::from(*c).min(a);
            *c = if a == 0 {
                0
            } else {
                ((v * 255 + a / 2) / a) as u8
            };
        }
    }
    out
}

fn png(icon: &RgbaImage) -> Vec<u8> {
    let mut buf = Cursor::new(Vec::new());
    icon.write_to(&mut buf, ImageFormat::Png)
        .expect("encode png");
    buf.into_inner()
}

/// BITMAPINFOHEADER, bottom-up BGRA rows, then the 1-bit AND mask, set where
/// alpha is below 128.
fn dib(icon: &RgbaImage) -> Vec<u8> {
    let (w, h) = icon.dimensions();
    let stride = w.div_ceil(32) as usize * 4;
    let mut xor = Vec::new();
    let mut mask = Vec::new();
    for y in (0..h).rev() {
        let mut row = vec![0u8; stride];
        for x in 0..w {
            let [r, g, b, a] = icon.get_pixel(x, y).0;
            xor.extend_from_slice(&[b, g, r, a]);
            if a < 128 {
                row[x as usize / 8] |= 0x80 >> (x % 8);
            }
        }
        mask.extend_from_slice(&row);
    }
    let mut out = Vec::with_capacity(40 + xor.len() + mask.len());
    out.extend_from_slice(&40u32.to_le_bytes());
    out.extend_from_slice(&(w as i32).to_le_bytes());
    out.extend_from_slice(&(h as i32 * 2).to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&32u16.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&((xor.len() + mask.len()) as u32).to_le_bytes());
    out.extend_from_slice(&[0u8; 16]);
    out.extend(xor);
    out.extend(mask);
    out
}

/// ICONDIR, one ICONDIRENTRY per frame (256 is written as 0), then the frames.
fn build_ico(frames: &[Vec<u8>]) -> Vec<u8> {
    let mut out = vec![0, 0, 1, 0, frames.len() as u8, 0];
    let mut offset = 6 + 16 * frames.len();
    for (&size, frame) in SIZES.iter().zip(frames) {
        let dim = if size == 256 { 0 } else { size as u8 };
        out.extend_from_slice(&[dim, dim, 0, 0]);
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&32u16.to_le_bytes());
        out.extend_from_slice(&(frame.len() as u32).to_le_bytes());
        out.extend_from_slice(&(offset as u32).to_le_bytes());
        offset += frame.len();
    }
    for frame in frames {
        out.extend_from_slice(frame);
    }
    out
}
