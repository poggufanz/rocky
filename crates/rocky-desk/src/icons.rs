//! 32x32 RGBA tray dot per aggregate status, generated in code.

use gpui_tray::Icon;
use rocky_proto::pipe::Status;

/// Fill color per aggregate. `Ended` never aggregates; treat as idle grey.
fn color(s: Status) -> [u8; 4] {
    match s {
        Status::NeedsYou => [0xE8, 0xB8, 0x00, 0xFF], // yellow
        Status::Failed => [0xD9, 0x2B, 0x2B, 0xFF],   // red
        Status::Working => [0x2B, 0x7D, 0xD9, 0xFF],  // blue
        Status::Done => [0x2B, 0xA0, 0x44, 0xFF],     // green
        Status::Idle | Status::Ended => [0x8A, 0x8A, 0x8A, 0xFF], // grey
    }
}

/// Solid disc on a transparent background, 1px margin.
pub fn tray_icon(s: Status) -> Icon {
    const W: u32 = 32;
    const R: f32 = 15.0;
    let [r, g, b, a] = color(s);
    let mut rgba = vec![0u8; (W * W * 4) as usize];
    for y in 0..W {
        for x in 0..W {
            let dx = x as f32 - 15.5;
            let dy = y as f32 - 15.5;
            if dx * dx + dy * dy <= R * R {
                let i = ((y * W + x) * 4) as usize;
                rgba[i] = r;
                rgba[i + 1] = g;
                rgba[i + 2] = b;
                rgba[i + 3] = a;
            }
        }
    }
    Icon::from_rgba(rgba, W, W)
        .build()
        .expect("32x32 RGBA is a valid icon")
}
