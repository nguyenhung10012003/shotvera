//! Recorder that works on every platform. Frames come from xcap's screen recorder (DXGI/WGC on
//! Windows, PipeWire/X11 on Linux, AVFoundation on macOS). They are cropped and scaled in Rust,
//! then encoded with OpenH264 or as a GIF. This recorder captures video only, without audio.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, sync_channel, Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use super::encode::{self, Fitter, Frame, GifSink, LoopEnd, Mp4Sink, Msg, Sink};
use super::{Handle, Job, Outcome, RecordFormat};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);

pub fn spawn(job: Job) -> Result<Handle, String> {
    let monitor = xcap::Monitor::all()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|m| m.id().ok() == Some(job.monitor_id))
        .ok_or("the display to record is no longer connected")?;

    // Bounded, so frames are dropped rather than piling up in memory when encoding falls behind.
    let (tx, rx) = sync_channel::<Msg>(3);
    let stop = Arc::new(AtomicBool::new(false));

    // Capture thread: forwards xcap's frames until it is told to stop.
    let (ready_tx, ready_rx) = channel::<Result<(), String>>();
    {
        let tx = tx.clone();
        let stop = stop.clone();
        thread::Builder::new()
            .name("shotvera-rec-capture".into())
            .spawn(move || {
                let (recorder, frames) = match monitor.video_recorder() {
                    Ok(pair) => pair,
                    Err(err) => {
                        let _ = ready_tx.send(Err(err.to_string()));
                        return;
                    }
                };
                if let Err(err) = recorder.start() {
                    let _ = ready_tx.send(Err(err.to_string()));
                    return;
                }
                let _ = ready_tx.send(Ok(()));
                while !stop.load(Ordering::Acquire) {
                    match frames.recv_timeout(Duration::from_millis(100)) {
                        Ok(f) => {
                            let frame = Frame {
                                width: f.width,
                                height: f.height,
                                rgba: f.raw,
                            };
                            let _ = tx.try_send(Msg::Frame(Instant::now(), frame));
                        }
                        Err(RecvTimeoutError::Timeout) => {}
                        Err(RecvTimeoutError::Disconnected) => {
                            let _ = tx.send(Msg::SourceEnded("the screen recorder stopped".into()));
                            break;
                        }
                    }
                }
                let _ = recorder.stop();
            })
            .map_err(|e| e.to_string())?;
    }
    if let Err(err) = wait_ready(&ready_rx) {
        stop.store(true, Ordering::Release);
        return Err(err);
    }

    // Encode thread: owns the output file.
    let (ready_tx, ready_rx) = channel::<Result<(), String>>();
    let encode_stop = stop.clone();
    let done = thread::Builder::new()
        .name("shotvera-rec-encode".into())
        .spawn(move || {
            let stop = encode_stop;
            let sink: Result<Box<dyn Sink>, String> = match job.format {
                RecordFormat::Mp4 => {
                    Mp4Sink::create(&job.output, job.out_width, job.out_height, job.fps)
                        .map(|s| Box::new(s) as Box<dyn Sink>)
                }
                RecordFormat::Gif => GifSink::create(&job.output, job.out_width, job.out_height)
                    .map(|s| Box::new(s) as Box<dyn Sink>),
            };
            let sink = match sink {
                Ok(sink) => {
                    let _ = ready_tx.send(Ok(()));
                    sink
                }
                Err(err) => {
                    stop.store(true, Ordering::Release);
                    let _ = ready_tx.send(Err(err.clone()));
                    return Err(err);
                }
            };
            let mut fitter = Fitter::new(Some(job.region), job.out_width, job.out_height);
            let result = encode::run(&rx, &mut fitter, sink, job.fps);
            stop.store(true, Ordering::Release);
            match result? {
                LoopEnd::Finished(duration) => Ok(Outcome::Saved {
                    path: job.output,
                    duration,
                    // This recorder has no audio, so a requested microphone is reported as unavailable.
                    mic_unavailable: job.microphone,
                }),
                LoopEnd::Cancelled => Ok(Outcome::Cancelled),
            }
        })
        .map_err(|e| e.to_string())?;
    if let Err(err) = wait_ready(&ready_rx) {
        stop.store(true, Ordering::Release);
        let _ = done.join();
        return Err(err);
    }
    Ok(Handle { tx, done })
}

fn wait_ready(rx: &Receiver<Result<(), String>>) -> Result<(), String> {
    match rx.recv_timeout(STARTUP_TIMEOUT) {
        Ok(result) => result,
        Err(_) => Err("the screen recorder did not start".into()),
    }
}
