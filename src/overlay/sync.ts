/**
 * Mirrors the shared overlay document across the overlay windows of every monitor, so a selection
 * (and the annotations inside it) can be drawn, moved and resized across monitor boundaries.
 * Each change made locally is broadcast in global units; received documents are converted back to
 * this window's CSS pixels.
 */
import type { Annotation } from "../lib/annotations";
import { emitDoc, onDoc } from "../lib/platform";
import { annotationToGlobal, annotationToLocal, rectToGlobal, rectToLocal, type Space } from "./space";
import { useOverlay, type SharedDoc } from "./store";

interface Envelope {
  from: number;
  session: number;
  doc: SharedDoc;
}

let applyingRemote = false;

const toGlobal = (s: Space, list: Annotation[]) => list.map((a) => annotationToGlobal(s, a));
const toLocal = (s: Space, list: Annotation[]) => list.map((a) => annotationToLocal(s, a));

export function startSync(): () => void {
  let scheduled = false;
  let sentPast: Annotation[][] | null = null;
  let sentFuture: Annotation[][] | null = null;

  const flush = () => {
    scheduled = false;
    const s = useOverlay.getState();
    if (!s.space || !s.frame || s.phase === "loading") return;
    const historyChanged = s.past !== sentPast || s.future !== sentFuture;
    sentPast = s.past;
    sentFuture = s.future;
    const space = s.space;
    const envelope: Envelope = {
      from: s.monitor,
      session: s.frame.sessionId,
      doc: {
        phase: s.phase,
        selection: s.selection && rectToGlobal(space, s.selection),
        annotations: toGlobal(space, s.annotations),
        tool: s.tool,
        style: s.style,
        aiOpen: s.aiOpen,
        ...(historyChanged
          ? { past: s.past.map((list) => toGlobal(space, list)), future: s.future.map((list) => toGlobal(space, list)) }
          : {}),
      },
    };
    void emitDoc(envelope);
  };

  const unsubscribe = useOverlay.subscribe((s, prev) => {
    if (applyingRemote) return;
    const changed =
      s.selection !== prev.selection ||
      s.annotations !== prev.annotations ||
      s.phase !== prev.phase ||
      s.tool !== prev.tool ||
      s.style !== prev.style ||
      s.aiOpen !== prev.aiOpen ||
      s.past !== prev.past ||
      s.future !== prev.future;
    if (!changed || scheduled) return;
    // Coalesce all changes made in the same tick into one message.
    scheduled = true;
    queueMicrotask(flush);
  });

  let unlisten: (() => void) | null = null;
  let alive = true;
  void onDoc<Envelope>((env) => {
    const s = useOverlay.getState();
    if (env.from === s.monitor || !s.space || !s.frame || env.session !== s.frame.sessionId) return;
    const space = s.space;
    const doc = env.doc;
    applyingRemote = true;
    try {
      s.applyRemote({
        ...doc,
        selection: doc.selection && rectToLocal(space, doc.selection),
        annotations: toLocal(space, doc.annotations),
        past: doc.past?.map((list) => toLocal(space, list)),
        future: doc.future?.map((list) => toLocal(space, list)),
      });
      // What we just received is already known to everyone; do not echo history back.
      sentPast = useOverlay.getState().past;
      sentFuture = useOverlay.getState().future;
    } finally {
      applyingRemote = false;
    }
  }).then((u) => {
    if (alive) unlisten = u;
    else u();
  });

  return () => {
    alive = false;
    unsubscribe();
    unlisten?.();
  };
}
