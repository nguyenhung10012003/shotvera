//! The frame pipeline shared by the recorder back ends: fit every captured frame to the output
//! size, then encode it as H.264 in an MP4 file (OpenH264) or as an animated GIF.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};

use fast_image_resize as fr;
use openh264::encoder::{
    BitRate, Encoder, EncoderConfig, FrameRate, FrameType, IntraFramePeriod, RateControlMode,
    UsageType,
};
use openh264::formats::{RgbaSliceU8, YUVBuffer};
use openh264::OpenH264API;

/// A tightly packed RGBA frame.
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// Messages to the encode loop: frames from the capture source and commands from the UI.
pub enum Msg {
    Frame(Instant, Frame),
    Pause,
    Resume,
    Stop,
    Cancel,
    /// The capture source failed or stopped by itself.
    SourceEnded(String),
}

/// How an encode loop ended.
pub enum LoopEnd {
    /// The file is complete. The value is the recorded length, not counting pauses.
    Finished(Duration),
    Cancelled,
}

/// A region given as fractions (0..1) of the source frame. This keeps it independent of pixel
/// density: xcap reports physical pixels, while on macOS the region is chosen in points.
#[derive(Clone, Copy, Debug)]
pub struct RelRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The output size for a region of `width`×`height` pixels. The long edge is capped at
/// `max_edge`, and both sides are rounded down to even numbers because H.264 requires it.
pub fn output_size(width: f64, height: f64, max_edge: u32) -> (u32, u32) {
    let scale = (max_edge as f64 / width.max(height)).min(1.0);
    let even = |v: f64| (((v * scale).round() as u32) / 2 * 2).max(16);
    (even(width), even(height))
}

/// Crops (optionally) and scales incoming frames to a fixed output size.
pub struct Fitter {
    crop: Option<RelRect>,
    width: u32,
    height: u32,
    resizer: fr::Resizer,
}

impl Fitter {
    pub fn new(crop: Option<RelRect>, width: u32, height: u32) -> Self {
        Self {
            crop,
            width,
            height,
            resizer: fr::Resizer::new(),
        }
    }

    pub fn fit(&mut self, frame: Frame) -> Result<Frame, String> {
        let (fw, fh) = (frame.width as f64, frame.height as f64);
        let (x, y, w, h) = match self.crop {
            Some(c) => {
                let x = (c.x * fw).round().clamp(0.0, fw - 1.0);
                let y = (c.y * fh).round().clamp(0.0, fh - 1.0);
                let w = (c.width * fw).round().clamp(1.0, fw - x);
                let h = (c.height * fh).round().clamp(1.0, fh - y);
                (x as u32, y as u32, w as u32, h as u32)
            }
            None => (0, 0, frame.width, frame.height),
        };
        if w == self.width && h == self.height {
            if x == 0 && y == 0 && frame.width == w && frame.height == h {
                return Ok(frame);
            }
            return Ok(copy_rect(&frame, x, y, w, h));
        }
        let src =
            fr::images::ImageRef::new(frame.width, frame.height, &frame.rgba, fr::PixelType::U8x4)
                .map_err(|e| e.to_string())?;
        let mut dst = fr::images::Image::new(self.width, self.height, fr::PixelType::U8x4);
        let options = fr::ResizeOptions::new()
            .resize_alg(fr::ResizeAlg::Convolution(fr::FilterType::Bilinear))
            .crop(x as f64, y as f64, w as f64, h as f64)
            .use_alpha(false);
        self.resizer
            .resize(&src, &mut dst, &options)
            .map_err(|e| e.to_string())?;
        Ok(Frame {
            width: self.width,
            height: self.height,
            rgba: dst.into_vec(),
        })
    }
}

fn copy_rect(frame: &Frame, x: u32, y: u32, w: u32, h: u32) -> Frame {
    let stride = frame.width as usize * 4;
    let row = w as usize * 4;
    let mut rgba = Vec::with_capacity(row * h as usize);
    for r in y as usize..(y + h) as usize {
        let start = r * stride + x as usize * 4;
        rgba.extend_from_slice(&frame.rgba[start..start + row]);
    }
    Frame {
        width: w,
        height: h,
        rgba,
    }
}

/// An output file. Each frame stays on screen from its `pts` until the next frame, or until `flush`.
pub trait Sink {
    fn push(&mut self, frame: Frame, pts: Duration) -> Result<(), String>;
    /// Ends the frame on screen at `end`. Called when pausing and before finishing.
    fn flush(&mut self, end: Duration) -> Result<(), String>;
    fn finish(self: Box<Self>, end: Duration) -> Result<(), String>;
}

/// Runs until Stop or Cancel. Timestamps frames on a clock that excludes pauses, drops frames
/// that arrive faster than `fps`, and passes the rest to `sink`.
pub fn run(
    rx: &Receiver<Msg>,
    fitter: &mut Fitter,
    mut sink: Box<dyn Sink>,
    fps: u32,
) -> Result<LoopEnd, String> {
    let min_gap = Duration::from_secs_f64(0.8 / fps.max(1) as f64);
    let start = Instant::now();
    let mut paused_since: Option<Instant> = None;
    let mut paused_total = Duration::ZERO;
    let mut last_pts: Option<Duration> = None;
    let clock =
        |at: Instant, paused: Duration| at.saturating_duration_since(start).saturating_sub(paused);

    loop {
        let msg = rx
            .recv()
            .map_err(|_| "the screen capture stopped unexpectedly".to_string())?;
        match msg {
            Msg::Frame(at, frame) => {
                if paused_since.is_some() || at < start {
                    continue;
                }
                let pts = clock(at, paused_total);
                if last_pts.is_some_and(|last| pts < last + min_gap) {
                    continue;
                }
                sink.push(fitter.fit(frame)?, pts)?;
                last_pts = Some(pts);
            }
            Msg::Pause => {
                if paused_since.is_none() {
                    let now = Instant::now();
                    sink.flush(clock(now, paused_total))?;
                    paused_since = Some(now);
                }
            }
            Msg::Resume => {
                if let Some(since) = paused_since.take() {
                    paused_total += since.elapsed();
                }
            }
            Msg::Stop => {
                let end = clock(paused_since.unwrap_or_else(Instant::now), paused_total);
                if last_pts.is_none() {
                    return Err("no frames were captured".into());
                }
                sink.finish(end)?;
                return Ok(LoopEnd::Finished(end));
            }
            Msg::Cancel => return Ok(LoopEnd::Cancelled),
            Msg::SourceEnded(err) => {
                if last_pts.is_none() {
                    return Err(err);
                }
                log::warn!("recording source ended early: {err}");
                let end = clock(paused_since.unwrap_or_else(Instant::now), paused_total);
                sink.finish(end)?;
                return Ok(LoopEnd::Finished(end));
            }
        }
    }
}

// ------------------------------------------------------------------------------------- MP4

struct PendingSample {
    bytes: Vec<u8>,
    sync: bool,
}

/// H.264 (OpenH264, built from source) in an MP4 container, at a variable frame rate. Each sample
/// lasts until the next one, so a static screen costs almost nothing.
///
/// The track timescale is the frame rate, so timestamps sit on the 1/fps grid: players and editors
/// then read the stream as `fps` frames per second rather than guessing 1000.
pub struct Mp4Sink {
    width: u32,
    height: u32,
    fps: u32,
    encoder: Encoder,
    file: Option<BufWriter<File>>,
    writer: Option<mp4::Mp4Writer<BufWriter<File>>>,
    pending: Option<PendingSample>,
    /// Start of the next sample, in frame ticks (the track timescale).
    next_start: u64,
}

const TRACK: u32 = 1;
/// Movie header timescale (milliseconds); the track uses the frame rate.
const MOVIE_TIMESCALE: u32 = 1000;

impl Mp4Sink {
    pub fn create(path: &Path, width: u32, height: u32, fps: u32) -> Result<Self, String> {
        // About 0.1 bit per pixel per frame works well for screen content (text, flat UI).
        let bitrate =
            (width as u64 * height as u64 * fps as u64 / 10).clamp(1_500_000, 16_000_000) as u32;
        let config = EncoderConfig::new()
            .bitrate(BitRate::from_bps(bitrate))
            .max_frame_rate(FrameRate::from_hz(fps as f32))
            .usage_type(UsageType::ScreenContentRealTime)
            // Not supported for screen content; OpenH264 would turn them off with a warning.
            .adaptive_quantization(false)
            .background_detection(false)
            .rate_control_mode(RateControlMode::Bitrate)
            // Lets the encoder hold the bitrate; a skipped frame just keeps the previous one on screen.
            .skip_frames(true)
            .intra_frame_period(IntraFramePeriod::from_num_frames(fps.max(1) * 4));
        let encoder = Encoder::with_api_config(OpenH264API::from_source(), config)
            .map_err(|e| e.to_string())?;
        let file = BufWriter::new(File::create(path).map_err(|e| e.to_string())?);
        Ok(Self {
            width,
            height,
            fps: fps.max(1),
            encoder,
            file: Some(file),
            writer: None,
            pending: None,
            next_start: 0,
        })
    }

    fn start_writer(&mut self, sps: Vec<u8>, pps: Vec<u8>) -> Result<(), String> {
        let file = self.file.take().ok_or("the MP4 file is already open")?;
        let brand = |s: &str| s.parse::<mp4::FourCC>().map_err(|e| e.to_string());
        let config = mp4::Mp4Config {
            major_brand: brand("isom")?,
            minor_version: 512,
            compatible_brands: vec![
                brand("isom")?,
                brand("iso2")?,
                brand("avc1")?,
                brand("mp41")?,
            ],
            timescale: MOVIE_TIMESCALE,
        };
        let mut writer = mp4::Mp4Writer::write_start(file, &config).map_err(|e| e.to_string())?;
        writer
            .add_track(&mp4::TrackConfig {
                track_type: mp4::TrackType::Video,
                timescale: self.fps,
                language: "und".into(),
                media_conf: mp4::MediaConfig::AvcConfig(mp4::AvcConfig {
                    width: self.width as u16,
                    height: self.height as u16,
                    seq_param_set: sps,
                    pic_param_set: pps,
                }),
            })
            .map_err(|e| e.to_string())?;
        self.writer = Some(writer);
        Ok(())
    }
}

/// Removes the Annex B start code (`00 00 01` or `00 00 00 01`) from the front of a NAL unit.
fn strip_start_code(nal: &[u8]) -> &[u8] {
    let zeros = nal.iter().take_while(|&&b| b == 0).count();
    if zeros >= 2 && nal.get(zeros) == Some(&1) {
        &nal[zeros + 1..]
    } else {
        nal
    }
}

impl Sink for Mp4Sink {
    fn push(&mut self, frame: Frame, pts: Duration) -> Result<(), String> {
        let yuv = YUVBuffer::from_rgba8_source(RgbaSliceU8::new(
            &frame.rgba,
            (frame.width as usize, frame.height as usize),
        ));
        let bitstream = self.encoder.encode(&yuv).map_err(|e| e.to_string())?;
        let sync = matches!(bitstream.frame_type(), FrameType::IDR | FrameType::I);
        let annex_b = bitstream.to_vec();

        // MP4 keeps SPS/PPS in the track header and stores each NAL unit with a 4-byte length prefix.
        let (mut sps, mut pps) = (None, None);
        let mut sample = Vec::with_capacity(annex_b.len());
        for nal in openh264::nal_units(&annex_b) {
            let nal = strip_start_code(nal);
            match nal.first().map(|b| b & 0x1f) {
                None => {}
                Some(7) => sps = Some(nal.to_vec()),
                Some(8) => pps = Some(nal.to_vec()),
                Some(_) => {
                    sample.extend_from_slice(&(nal.len() as u32).to_be_bytes());
                    sample.extend_from_slice(nal);
                }
            }
        }
        if self.writer.is_none() {
            let (Some(sps), Some(pps)) = (sps, pps) else {
                return Ok(()); // wait for the first keyframe
            };
            self.start_writer(sps, pps)?;
        }
        if sample.is_empty() {
            return Ok(()); // the encoder skipped this frame; the previous one stays on screen
        }
        self.flush(pts)?;
        self.pending = Some(PendingSample {
            bytes: sample,
            sync,
        });
        Ok(())
    }

    fn flush(&mut self, end: Duration) -> Result<(), String> {
        let Some(p) = self.pending.take() else {
            return Ok(());
        };
        let writer = self.writer.as_mut().ok_or("the MP4 file is not open")?;
        // Every sample lasts at least one tick, so timestamps always increase.
        let end_tick = (end.as_secs_f64() * self.fps as f64).round() as u64;
        let duration = end_tick
            .saturating_sub(self.next_start)
            .clamp(1, u32::MAX as u64) as u32;
        writer
            .write_sample(
                TRACK,
                &mp4::Mp4Sample {
                    start_time: self.next_start,
                    duration,
                    rendering_offset: 0,
                    is_sync: p.sync,
                    bytes: bytes::Bytes::from(p.bytes),
                },
            )
            .map_err(|e| e.to_string())?;
        self.next_start += duration as u64;
        Ok(())
    }

    fn finish(mut self: Box<Self>, end: Duration) -> Result<(), String> {
        self.flush(end)?;
        let mut writer = self.writer.take().ok_or("no video frames were encoded")?;
        writer.write_end().map_err(|e| e.to_string())?;
        writer.into_writer().flush().map_err(|e| e.to_string())
    }
}

// ------------------------------------------------------------------------------------- GIF

/// Animated GIF. Consecutive identical frames are merged into one longer frame.
pub struct GifSink {
    encoder: gif::Encoder<BufWriter<File>>,
    pending: Option<(gif::Frame<'static>, Duration)>,
    last: Vec<u8>,
}

impl GifSink {
    pub fn create(path: &Path, width: u32, height: u32) -> Result<Self, String> {
        let file = BufWriter::new(File::create(path).map_err(|e| e.to_string())?);
        let mut encoder =
            gif::Encoder::new(file, width as u16, height as u16, &[]).map_err(|e| e.to_string())?;
        encoder
            .set_repeat(gif::Repeat::Infinite)
            .map_err(|e| e.to_string())?;
        Ok(Self {
            encoder,
            pending: None,
            last: Vec::new(),
        })
    }
}

impl Sink for GifSink {
    fn push(&mut self, frame: Frame, pts: Duration) -> Result<(), String> {
        if frame.rgba == self.last {
            return Ok(());
        }
        self.last.clone_from(&frame.rgba);
        let mut rgba = frame.rgba;
        // NeuQuant speed 10 (of 1-30): good palettes while still keeping up at about 12 fps.
        let quantized =
            gif::Frame::from_rgba_speed(frame.width as u16, frame.height as u16, &mut rgba, 10);
        self.flush(pts)?;
        self.pending = Some((quantized, pts));
        Ok(())
    }

    fn flush(&mut self, end: Duration) -> Result<(), String> {
        let Some((mut frame, pts)) = self.pending.take() else {
            return Ok(());
        };
        // GIF delays are in hundredths of a second. Browsers treat a delay under 2 as 10.
        frame.delay = (end.saturating_sub(pts).as_millis() / 10).clamp(2, u16::MAX as u128) as u16;
        self.encoder.write_frame(&frame).map_err(|e| e.to_string())
    }

    fn finish(mut self: Box<Self>, end: Duration) -> Result<(), String> {
        self.flush(end)?;
        let mut file = self.encoder.into_inner().map_err(|e| e.to_string())?;
        file.flush().map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_size_is_even_and_capped() {
        assert_eq!(output_size(1001.0, 501.0, 4000), (1000, 500));
        assert_eq!(output_size(3840.0, 2160.0, 1920), (1920, 1080));
        assert_eq!(output_size(500.0, 4000.0, 1000), (124, 1000));
    }

    #[test]
    fn strips_both_start_code_lengths() {
        assert_eq!(strip_start_code(&[0, 0, 0, 1, 0x67, 1]), &[0x67, 1]);
        assert_eq!(strip_start_code(&[0, 0, 1, 0x68]), &[0x68]);
        assert_eq!(strip_start_code(&[0x65, 0, 0]), &[0x65, 0, 0]);
    }

    fn gradient(w: u32, h: u32, shift: u32) -> Frame {
        let mut rgba = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for x in 0..w {
                rgba.extend_from_slice(&[((x + shift) % 256) as u8, (y % 256) as u8, 128, 255]);
            }
        }
        Frame {
            width: w,
            height: h,
            rgba,
        }
    }

    #[test]
    fn fitter_crops_and_scales() {
        let mut fitter = Fitter::new(
            Some(RelRect {
                x: 0.25,
                y: 0.25,
                width: 0.5,
                height: 0.5,
            }),
            50,
            50,
        );
        let out = fitter.fit(gradient(200, 200, 0)).unwrap();
        assert_eq!(
            (out.width, out.height, out.rgba.len()),
            (50, 50, 50 * 50 * 4)
        );
        let mut exact = Fitter::new(
            Some(RelRect {
                x: 0.5,
                y: 0.0,
                width: 0.5,
                height: 1.0,
            }),
            100,
            200,
        );
        let out = exact.fit(gradient(200, 200, 0)).unwrap();
        assert_eq!(out.rgba[0], 100); // the first pixel comes from x = 100
    }

    #[test]
    fn writes_playable_mp4_and_gif() {
        let dir = std::env::temp_dir();
        let mp4_path = dir.join("shotvera-test.mp4");
        let mut mp4 = Box::new(Mp4Sink::create(&mp4_path, 320, 240, 30).unwrap());
        for i in 0..30 {
            mp4.push(
                gradient(320, 240, i * 4),
                Duration::from_millis(i as u64 * 33),
            )
            .unwrap();
        }
        mp4.finish(Duration::from_secs(1)).unwrap();
        let file = File::open(&mp4_path).unwrap();
        let size = file.metadata().unwrap().len();
        let reader = mp4::Mp4Reader::read_header(std::io::BufReader::new(file), size).unwrap();
        let track = reader.tracks().get(&TRACK).unwrap();
        assert_eq!(
            (track.width(), track.height(), track.sample_count()),
            (320, 240, 30)
        );
        assert_eq!(track.timescale(), 30); // timestamps on the 1/30 s grid
        assert!(reader.duration() >= Duration::from_millis(990));

        let gif_path = dir.join("shotvera-test.gif");
        let mut gif = Box::new(GifSink::create(&gif_path, 64, 48).unwrap());
        gif.push(gradient(64, 48, 0), Duration::ZERO).unwrap();
        gif.push(gradient(64, 48, 0), Duration::from_millis(100))
            .unwrap(); // merged with the first
        gif.push(gradient(64, 48, 9), Duration::from_millis(500))
            .unwrap();
        gif.finish(Duration::from_millis(800)).unwrap();
        let mut decoder = gif::DecodeOptions::new()
            .read_info(File::open(&gif_path).unwrap())
            .unwrap();
        let mut delays = Vec::new();
        while let Some(frame) = decoder.read_next_frame().unwrap() {
            delays.push(frame.delay);
        }
        assert_eq!(delays, vec![50, 30]);
    }
}
