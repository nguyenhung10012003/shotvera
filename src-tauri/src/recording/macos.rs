//! Native macOS recorder built on AVFoundation.
//!
//! MP4: an AVCaptureScreenInput (AVFoundation crops, scales and limits the frame rate itself) and
//! an optional microphone feed an AVCaptureMovieFileOutput, which uses the hardware H.264 and AAC
//! encoders. Its QuickTime file is then remuxed to MP4 without re-encoding.
//!
//! GIF: the same screen input delivers small BGRA frames to the shared GIF encoder.
#![allow(deprecated)] // AVCaptureScreenInput still works; ScreenCaptureKit is on the roadmap.

use std::fs;
use std::path::Path;
use std::slice;
use std::sync::mpsc::{channel, sync_channel, Receiver, Sender, SyncSender};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use block2::RcBlock;
use dispatch2::{DispatchQueue, DispatchQueueAttr};
use objc2::rc::Retained;
use objc2::runtime::{Bool, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
use objc2_av_foundation::{
    AVAssetExportPresetPassthrough, AVAssetExportSession, AVAssetExportSessionStatus,
    AVAuthorizationStatus, AVCaptureConnection, AVCaptureDevice, AVCaptureDeviceInput,
    AVCaptureFileOutput, AVCaptureFileOutputRecordingDelegate, AVCaptureMovieFileOutput,
    AVCaptureOutput, AVCaptureScreenInput, AVCaptureSession, AVCaptureVideoDataOutput,
    AVCaptureVideoDataOutputSampleBufferDelegate, AVFileTypeMPEG4, AVMediaTypeAudio, AVURLAsset,
};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_core_media::{CMSampleBuffer, CMTime};
use objc2_core_video::{
    kCVPixelBufferPixelFormatTypeKey, kCVPixelFormatType_32BGRA, CVPixelBufferGetBaseAddress,
    CVPixelBufferGetBytesPerRow, CVPixelBufferGetHeight, CVPixelBufferGetWidth,
    CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
};
use objc2_foundation::{
    NSArray, NSDictionary, NSError, NSNumber, NSObject, NSObjectProtocol, NSString, NSURL,
};

use super::encode::{self, Fitter, Frame, GifSink, LoopEnd, Msg};
use super::{Handle, Job, Outcome, RecordFormat};

/// Long enough for the user to answer the first-time microphone permission prompt.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(70);

pub fn spawn(job: Job) -> Result<Handle, String> {
    let (tx, rx) = sync_channel::<Msg>(3);
    let (ready_tx, ready_rx) = channel::<Result<(), String>>();
    let frame_tx = tx.clone();
    let done = thread::Builder::new()
        .name("shotvera-rec-macos".into())
        .spawn(move || match job.format {
            RecordFormat::Mp4 => record_movie(job, rx, ready_tx),
            RecordFormat::Gif => record_frames(job, frame_tx, rx, ready_tx),
        })
        .map_err(|e| e.to_string())?;
    match ready_rx.recv_timeout(STARTUP_TIMEOUT) {
        Ok(Ok(())) => Ok(Handle { tx, done }),
        Ok(Err(err)) => {
            let _ = done.join();
            Err(err)
        }
        Err(_) => Err("the screen recorder did not start".into()),
    }
}

// ----------------------------------------------------------------------------- delegates

struct FileDelegateIvars {
    started: Mutex<Option<Sender<()>>>,
    done: Mutex<Option<Sender<Option<String>>>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "ShotveraRecordingDelegate"]
    #[ivars = FileDelegateIvars]
    struct FileDelegate;

    unsafe impl AVCaptureFileOutputRecordingDelegate for FileDelegate {
        // The session takes about a second to start writing; the UI waits for this.
        #[unsafe(method(captureOutput:didStartRecordingToOutputFileAtURL:fromConnections:))]
        unsafe fn did_start(
            &self,
            _output: &AVCaptureFileOutput,
            _url: &NSURL,
            _connections: &NSArray<AVCaptureConnection>,
        ) {
            if let Some(tx) = self
                .ivars()
                .started
                .lock()
                .ok()
                .and_then(|mut slot| slot.take())
            {
                let _ = tx.send(());
            }
        }

        #[unsafe(method(captureOutput:didFinishRecordingToOutputFileAtURL:fromConnections:error:))]
        unsafe fn did_finish(
            &self,
            _output: &AVCaptureFileOutput,
            _url: &NSURL,
            _connections: &NSArray<AVCaptureConnection>,
            error: Option<&NSError>,
        ) {
            let error = error.map(|e| e.localizedDescription().to_string());
            if let Some(tx) = self
                .ivars()
                .done
                .lock()
                .ok()
                .and_then(|mut slot| slot.take())
            {
                let _ = tx.send(error);
            }
        }
    }
);

unsafe impl NSObjectProtocol for FileDelegate {}

impl FileDelegate {
    fn new(started: Sender<()>, done: Sender<Option<String>>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(FileDelegateIvars {
            started: Mutex::new(Some(started)),
            done: Mutex::new(Some(done)),
        });
        unsafe { msg_send![super(this), init] }
    }
}

struct FrameDelegateIvars {
    tx: SyncSender<Msg>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "ShotveraFrameDelegate"]
    #[ivars = FrameDelegateIvars]
    struct FrameDelegate;

    unsafe impl AVCaptureVideoDataOutputSampleBufferDelegate for FrameDelegate {
        #[unsafe(method(captureOutput:didOutputSampleBuffer:fromConnection:))]
        unsafe fn did_output(
            &self,
            _output: &AVCaptureOutput,
            sample: &CMSampleBuffer,
            _connection: &AVCaptureConnection,
        ) {
            if let Some(frame) = unsafe { bgra_frame(sample) } {
                // When the encoder is busy, drop the frame instead of queueing it.
                let _ = self.ivars().tx.try_send(Msg::Frame(Instant::now(), frame));
            }
        }
    }
);

unsafe impl NSObjectProtocol for FrameDelegate {}

impl FrameDelegate {
    fn new(tx: SyncSender<Msg>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(FrameDelegateIvars { tx });
        unsafe { msg_send![super(this), init] }
    }
}

/// Copies a BGRA sample buffer into a packed RGBA frame.
unsafe fn bgra_frame(sample: &CMSampleBuffer) -> Option<Frame> {
    let buffer = unsafe { sample.image_buffer() }?;
    unsafe { CVPixelBufferLockBaseAddress(&buffer, CVPixelBufferLockFlags::ReadOnly) };
    let width = CVPixelBufferGetWidth(&buffer);
    let height = CVPixelBufferGetHeight(&buffer);
    let stride = CVPixelBufferGetBytesPerRow(&buffer);
    let base = CVPixelBufferGetBaseAddress(&buffer);
    let frame = (!base.is_null() && stride >= width * 4).then(|| {
        // SAFETY: the buffer is locked and spans `stride * height` bytes.
        let data = unsafe { slice::from_raw_parts(base.cast::<u8>(), stride * height) };
        let mut rgba = Vec::with_capacity(width * height * 4);
        for row in data.chunks_exact(stride).take(height) {
            for px in row[..width * 4].chunks_exact(4) {
                rgba.extend_from_slice(&[px[2], px[1], px[0], 255]);
            }
        }
        Frame {
            width: width as u32,
            height: height as u32,
            rgba,
        }
    });
    unsafe { CVPixelBufferUnlockBaseAddress(&buffer, CVPixelBufferLockFlags::ReadOnly) };
    frame
}

// ----------------------------------------------------------------------------- capture setup

fn ns_error(e: &NSError) -> String {
    e.localizedDescription().to_string()
}

fn file_url(path: &Path) -> Retained<NSURL> {
    NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()))
}

/// The screen input for `job`, producing frames `out_width` pixels wide.
unsafe fn screen_input(job: &Job) -> Result<Retained<AVCaptureScreenInput>, String> {
    let input = unsafe {
        AVCaptureScreenInput::initWithDisplayID(AVCaptureScreenInput::alloc(), job.monitor_id)
    }
    .ok_or("this display cannot be recorded")?;
    let (x, y, w, h) = job.local;
    // `cropRect` uses the display's own coordinates: points, with the origin at the bottom-left.
    let crop = CGRect::new(
        CGPoint::new(x, job.monitor_size.1 - y - h),
        CGSize::new(w, h),
    );
    unsafe {
        input.setCropRect(crop);
        // Unscaled frames have one pixel per physical pixel, which is `job.scale` per point.
        input.setScaleFactor(job.out_width as f64 / (w * job.scale));
        input.setMinFrameDuration(CMTime::new(1, job.fps as i32));
        input.setCapturesCursor(true);
        input.setCapturesMouseClicks(job.show_clicks);
    }
    Ok(input)
}

/// The default microphone. Asks for permission the first time.
unsafe fn microphone_input() -> Result<Retained<AVCaptureDeviceInput>, String> {
    let audio = unsafe { AVMediaTypeAudio }.ok_or("audio capture is unavailable")?;
    let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(audio) };
    if status == AVAuthorizationStatus::NotDetermined {
        let (tx, rx) = channel();
        let handler = RcBlock::new(move |granted: Bool| {
            let _ = tx.send(granted.as_bool());
        });
        unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(audio, &handler) };
        if !rx.recv_timeout(Duration::from_secs(60)).unwrap_or(false) {
            return Err("microphone access was not granted".into());
        }
    } else if status != AVAuthorizationStatus::Authorized {
        return Err("microphone access is turned off in System Settings".into());
    }
    let device = unsafe { AVCaptureDevice::defaultDeviceWithMediaType(audio) }
        .ok_or("no microphone found")?;
    unsafe { AVCaptureDeviceInput::deviceInputWithDevice_error(&device) }.map_err(|e| ns_error(&e))
}

// ----------------------------------------------------------------------------- MP4

struct Movie {
    session: Retained<AVCaptureSession>,
    output: Retained<AVCaptureMovieFileOutput>,
    _delegate: Retained<FileDelegate>,
    started: Receiver<()>,
    finished: Receiver<Option<String>>,
    microphone: bool,
}

unsafe fn start_movie(job: &Job, temp: &Path) -> Result<Movie, String> {
    let session = unsafe { AVCaptureSession::new() };
    let screen = unsafe { screen_input(job) }?;
    unsafe {
        if !session.canAddInput(&screen) {
            return Err("this display cannot be recorded".into());
        }
        session.addInput(&screen);
    }
    let mut microphone = false;
    if job.microphone {
        match unsafe { microphone_input() } {
            Ok(mic) if unsafe { session.canAddInput(&mic) } => {
                unsafe { session.addInput(&mic) };
                microphone = true;
            }
            Ok(_) => log::warn!("the microphone cannot be added to the capture session"),
            Err(err) => log::warn!("recording without sound: {err}"),
        }
    }
    let output = unsafe { AVCaptureMovieFileOutput::new() };
    unsafe {
        if !session.canAddOutput(&output) {
            return Err("cannot write the recording".into());
        }
        session.addOutput(&output);
        session.startRunning();
    }
    let (started_tx, started) = channel();
    let (done_tx, finished) = channel();
    let delegate = FileDelegate::new(started_tx, done_tx);
    unsafe {
        output.startRecordingToOutputFileURL_recordingDelegate(
            &file_url(temp),
            ProtocolObject::from_ref(&*delegate),
        );
    }
    Ok(Movie {
        session,
        output,
        _delegate: delegate,
        started,
        finished,
        microphone,
    })
}

fn record_movie(
    job: Job,
    rx: Receiver<Msg>,
    ready: Sender<Result<(), String>>,
) -> Result<Outcome, String> {
    let stem = job
        .output
        .file_stem()
        .map_or("recording".into(), |s| s.to_string_lossy().into_owned());
    let temp = job.temp_dir.join(format!("{stem}.mov"));
    let _ = fs::remove_file(&temp);
    // Ready only once the file is really being written, so the timer and the file agree.
    let started = unsafe { start_movie(&job, &temp) }.and_then(|movie| {
        match movie.started.recv_timeout(Duration::from_secs(10)) {
            Ok(()) => Ok(movie),
            Err(_) => {
                unsafe { movie.session.stopRunning() };
                Err("the screen recorder did not start".into())
            }
        }
    });
    let movie = match started {
        Ok(movie) => {
            let _ = ready.send(Ok(()));
            movie
        }
        Err(err) => {
            let _ = ready.send(Err(err.clone()));
            return Err(err);
        }
    };

    let start = Instant::now();
    let mut paused_since: Option<Instant> = None;
    let mut paused_total = Duration::ZERO;
    let cancelled = loop {
        match rx.recv() {
            Ok(Msg::Pause) if paused_since.is_none() => {
                unsafe { movie.output.pauseRecording() };
                paused_since = Some(Instant::now());
            }
            Ok(Msg::Resume) => {
                if let Some(since) = paused_since.take() {
                    unsafe { movie.output.resumeRecording() };
                    paused_total += since.elapsed();
                }
            }
            Ok(Msg::Stop) => break false,
            Ok(Msg::Cancel) | Err(_) => break true,
            Ok(_) => {}
        }
    };
    let duration = paused_since
        .unwrap_or_else(Instant::now)
        .duration_since(start)
        .saturating_sub(paused_total);

    unsafe { movie.output.stopRecording() };
    let finished = movie.finished.recv_timeout(Duration::from_secs(30));
    unsafe { movie.session.stopRunning() };
    if cancelled {
        let _ = fs::remove_file(&temp);
        return Ok(Outcome::Cancelled);
    }
    match finished {
        Ok(None) => {}
        // AVFoundation also reports some complete recordings with an error, for example when it
        // stopped because the disk filled up. Keep whatever it wrote.
        Ok(Some(err)) if temp.exists() => log::warn!("recording finished with: {err}"),
        Ok(Some(err)) => return Err(err),
        Err(_) => return Err("the recording did not finish in time".into()),
    }

    let path = match unsafe { remux_to_mp4(&temp, &job.output) } {
        Ok(()) => {
            let _ = fs::remove_file(&temp);
            job.output.clone()
        }
        Err(err) => {
            log::warn!("MP4 remux failed ({err}); keeping the QuickTime file");
            let mov = job.output.with_extension("mov");
            move_file(&temp, &mov)?;
            mov
        }
    };
    Ok(Outcome::Saved {
        path,
        duration,
        mic_unavailable: job.microphone && !movie.microphone,
    })
}

/// Rewraps the QuickTime file as MP4. This is a passthrough: audio and video are not re-encoded.
unsafe fn remux_to_mp4(src: &Path, dst: &Path) -> Result<(), String> {
    let asset = unsafe { AVURLAsset::URLAssetWithURL_options(&file_url(src), None) };
    let export = unsafe {
        AVAssetExportSession::exportSessionWithAsset_presetName(
            &asset,
            AVAssetExportPresetPassthrough,
        )
    }
    .ok_or("passthrough export is unavailable")?;
    let (tx, rx) = channel();
    let handler = RcBlock::new(move || {
        let _ = tx.send(());
    });
    unsafe {
        export.setOutputURL(Some(&file_url(dst)));
        export.setOutputFileType(AVFileTypeMPEG4);
        export.exportAsynchronouslyWithCompletionHandler(&handler);
    }
    rx.recv_timeout(Duration::from_secs(600))
        .map_err(|_| "the MP4 export timed out".to_string())?;
    if unsafe { export.status() } == AVAssetExportSessionStatus::Completed {
        Ok(())
    } else {
        Err(unsafe { export.error() }
            .map_or_else(|| "the MP4 export failed".into(), |e| ns_error(&e)))
    }
}

fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    // The files are on different volumes: copy, then remove the original.
    fs::copy(from, to).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(from);
    Ok(())
}

// ----------------------------------------------------------------------------- GIF

struct Frames {
    session: Retained<AVCaptureSession>,
    _output: Retained<AVCaptureVideoDataOutput>,
    _delegate: Retained<FrameDelegate>,
}

unsafe fn start_frames(job: &Job, tx: SyncSender<Msg>) -> Result<Frames, String> {
    let session = unsafe { AVCaptureSession::new() };
    let screen = unsafe { screen_input(job) }?;
    let output = unsafe { AVCaptureVideoDataOutput::new() };
    let delegate = FrameDelegate::new(tx);
    unsafe {
        if !session.canAddInput(&screen) {
            return Err("this display cannot be recorded".into());
        }
        session.addInput(&screen);

        output.setAlwaysDiscardsLateVideoFrames(true);
        let key = NSString::from_str(&kCVPixelBufferPixelFormatTypeKey.to_string());
        let value = NSNumber::new_u32(kCVPixelFormatType_32BGRA);
        let settings = NSDictionary::from_slices::<NSString>(&[key.as_ref()], &[value.as_ref()]);
        output.setVideoSettings(Some(&settings));
        if !session.canAddOutput(&output) {
            return Err("cannot read frames from this display".into());
        }
        session.addOutput(&output);

        let queue = DispatchQueue::new("app.shotvera.recording", DispatchQueueAttr::SERIAL);
        let queue: &DispatchQueue = queue.as_ref();
        let delegate_ref =
            ProtocolObject::<dyn AVCaptureVideoDataOutputSampleBufferDelegate>::from_ref(
                &*delegate,
            );
        let _: () = msg_send![&output, setSampleBufferDelegate: delegate_ref, queue: queue];
        session.startRunning();
    }
    Ok(Frames {
        session,
        _output: output,
        _delegate: delegate,
    })
}

fn record_frames(
    job: Job,
    tx: SyncSender<Msg>,
    rx: Receiver<Msg>,
    ready: Sender<Result<(), String>>,
) -> Result<Outcome, String> {
    let started = unsafe { start_frames(&job, tx) }.and_then(|frames| {
        match GifSink::create(&job.output, job.out_width, job.out_height) {
            Ok(sink) => Ok((frames, sink)),
            Err(err) => {
                unsafe { frames.session.stopRunning() };
                Err(err)
            }
        }
    });
    let (frames, sink) = match started {
        Ok(pair) => {
            let _ = ready.send(Ok(()));
            pair
        }
        Err(err) => {
            let _ = ready.send(Err(err.clone()));
            return Err(err);
        }
    };
    // Frames already arrive at the output size. The fitter only corrects rounding differences.
    let mut fitter = Fitter::new(None, job.out_width, job.out_height);
    let result = encode::run(&rx, &mut fitter, Box::new(sink), job.fps);
    unsafe { frames.session.stopRunning() };
    Ok(match result? {
        LoopEnd::Finished(duration) => Outcome::Saved {
            path: job.output,
            duration,
            mic_unavailable: false,
        },
        LoopEnd::Cancelled => Outcome::Cancelled,
    })
}
