'use client';

import {
  FormEvent,
  MutableRefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

const PRIMARY_REACTION_EMOJIS = ['😂', '❓', '💀', '😭', '❤️'] as const;
const REACTION_EMOJIS = [
  ...PRIMARY_REACTION_EMOJIS,
  '🤣',
  '😮',
  '😱',
  '😍',
  '🥹',
  '👀',
  '🤔',
  '😡',
  '🤯',
  '👏',
  '🔥',
  '👍',
  '👎',
  '🎉',
  '😬',
] as const;
const OBSERVATION_INTERVALS_SECONDS = [5, 10, 15] as const;
const DEFAULT_OBSERVATION_INTERVAL_SECONDS = 5;
const VIEWER_REACTION_COOLDOWN_MS = 3_000;
const MAX_AGENT_REACTIONS = 5;
const DEFAULT_LOOK_MODE = 'moments';
const LOOK_SETTINGS_KEY = 'watch-with-gpt:look-settings';
const KEY_MOMENT_FALLBACK_SECONDS = 60;
// Look this long after a seek lands, so the new frame has rendered.
const SEEK_SETTLE_SECONDS = 2.5;
// Return a no-capture result this often so a pending call never sits for minutes.
const OBSERVER_HEARTBEAT_MS = 30_000;
// End the loop if playback stays paused this long.
const PAUSE_LIMIT_MS = 10 * 60_000;
const NOTES_KEY_PREFIX = 'watch-with-gpt:notes:';
const MAX_NOTE_LENGTH = 2_000;
// Label a note as written late when GPT describes a moment this long after it.
const NOTE_LATE_SECONDS = 5;
const WAKE_LABELS: Record<WakeReason, string> = {
  look_request: 'Look now',
  mark_request: 'Mark',
  user_signal: 'emoji',
  interval: 'interval',
  key_moment: 'key moment',
  playback_event: 'play/pause/seek',
  heartbeat: 'heartbeat',
};
// The one-line reminder each observation carries, by wake reason.
const NEXT_STEP: Record<WakeReason, string> = {
  look_request: 'The viewer asked you to look. Capture .player-frame now, respond, then observe again.',
  mark_request:
    'The viewer marked this moment. Capture .player-frame, call watch_add_note with markId and a one-line description, then observe again.',
  user_signal: 'Capture .player-frame, briefly acknowledge the emoji, then observe again.',
  interval: 'Capture .player-frame; comment only if worthwhile. Then observe again.',
  key_moment: 'Capture .player-frame; comment only if worthwhile. Then observe again.',
  playback_event: 'No capture needed. Observe again.',
  heartbeat: 'No capture needed. Observe again.',
};
const CAPTURE_WAKES: readonly string[] = [
  'look_request',
  'mark_request',
  'user_signal',
  'interval',
  'key_moment',
];

const WATCH_PROTOCOL = {
  role: 'Share the open video with the user as a natural viewing companion.',
  userIntent:
    'The user decides what kind of company they want. Follow their current request; watching together does not require a fixed amount of commentary or reactions.',
  observation:
    'When the user asks you to watch, run each observation as one programmatic browser call: await watch_observe_next_moment and, only if observation.capture is true, capture the rendered .player-frame in the very next browser operation; return the observation (and image, if captured) together. Never yield to model reasoning between the WebMCP result and the capture. Repeat in the same turn. The observer follows play, pause, and seek and keeps waiting while paused, so a pause does not end the watch-along. It wakes on the look mode schedule, when the viewer presses Look now or sends an emoji, on playback events, and on a short heartbeat. If the viewer asks out loud to look at something, capture .player-frame right away, answer, then resume observing. Stop only when the user asks or the observer returns an error.',
  lookModes:
    'request: capture only when the viewer asks (Look now, emoji, or voice). moments: capture shortly after seeks and periodically as a fallback. interval: capture every few seconds of playback. Keep the viewer\'s selected mode; change it with watch_configure only when they ask.',
  captureBadge:
    'When an observation has capture: true, the player shows a small badge with that observation\'s seq and timecode for a few seconds. If a captured image shows a different seq, or no badge, treat it as stale or delayed.',
  notes:
    'The page keeps timestamped notes beside the video. When the viewer says "mark this" or "note that…", call watch_add_note right away; if you write it after the moment has passed, pass the timecode of when they asked. When the viewer presses Mark, the observer returns mark_request with a markId: capture the frame and describe it with watch_add_note. Use watch_get_notes to recall earlier notes.',
  statusCheck:
    'Use watch_get_status for a cheap check of playback state; do not re-read watch_get_session just to see whether the video is moving.',
  behavior: [
    'Stay quiet by default.',
    'Do not comment on every observation.',
    'Every viewer emoji is intentional input. Acknowledge it in context with a brief comment, answer, or reaction; do not end the watch-along after acknowledging it.',
    'Do not pause playback solely because the viewer sent an emoji.',
    'Prefer a lightweight reaction when that communicates enough.',
    'Keep comments and reactions tied to the current playback moment.',
    'Do not infer or reveal events beyond the current playback position.',
    'Pause playback before a longer response when video and conversation would compete.',
  ],
  reactions: REACTION_EMOJIS,
} as const;

type SourceKind = 'youtube' | 'direct' | 'embed';
type PlaybackStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'unavailable';

type VideoSource =
  | { kind: 'youtube'; url: string; videoId: string; startSeconds: number | null }
  | { kind: 'direct'; url: string; startSeconds: number | null }
  | { kind: 'embed'; url: string };

type MediaMetadata = {
  sessionId: string;
  sourceKind: SourceKind;
  sourceId: string;
  providerName: string | null;
  title: string | null;
  authorName: string | null;
  publishedAt: string | null;
  viewCount: string | null;
  status: 'loading' | 'partial' | 'unavailable';
  missingFields: string[];
};

type PlaybackSnapshot = {
  sourceUrl: string | null;
  sourceKind: SourceKind | null;
  status: PlaybackStatus;
  currentTime: number | null;
  duration: number | null;
  controllable: boolean;
};

type PlayerController = {
  play: () => Promise<boolean>;
  pause: () => Promise<boolean>;
  seek: (seconds: number) => void;
};

type ReactionEmoji = (typeof REACTION_EMOJIS)[number];
type ObservationIntervalSeconds = (typeof OBSERVATION_INTERVALS_SECONDS)[number];

// request: look only when the viewer asks (button, emoji, or voice).
// moments: look shortly after seeks, plus a fallback every KEY_MOMENT_FALLBACK_SECONDS.
// interval: look every 5/10/15 seconds of playback.
type LookMode = 'request' | 'moments' | 'interval';

type Note = {
  id: string;
  // The moment the note is about.
  time: number | null;
  // Playback position when the text was written; differs from time when GPT
  // describes a moment after the fact.
  writtenAt: number | null;
  text: string;
  // mark: the viewer pressed Mark and GPT is asked to describe the moment.
  source: 'viewer' | 'gpt' | 'mark';
  observationSeq: number | null;
  createdAt: string;
};

type StoredNotes = {
  title: string | null;
  url: string;
  notes: Note[];
};

type UserSignal = {
  id: string;
  kind: 'emoji' | 'look' | 'mark';
  emoji: ReactionEmoji | null;
  markId?: string;
  createdAt: string;
  playbackTime: number | null;
  timecode: string | null;
};

type TimelineEvent = {
  type: 'started' | 'paused' | 'resumed' | 'seeked' | 'ended' | 'stop_at';
  timecode: string | null;
  fromTimecode?: string | null;
};

type WakeReason =
  | 'look_request'
  | 'mark_request'
  | 'user_signal'
  | 'interval'
  | 'key_moment'
  | 'playback_event'
  | 'heartbeat';

type ObservationWake =
  | { reason: WakeReason; signal: UserSignal | null }
  | { reason: 'cancelled' | 'ended' | 'stop_at' | 'paused_too_long' | 'session_changed' };

type ObserverStatus = {
  waiting: boolean;
  endedAt: number;
  last: { seq: number; reason: WakeReason; capture: boolean; timecode: string | null } | null;
};

type ObservationWaiter = {
  timerId: number;
  resolve: (wake: ObservationWake) => void;
};

type ObservationCursor = {
  sourceUrl: string;
  nextCheckpointTime: number | null;
};

type PlaybackSample = {
  mediaTime: number;
  sampledAt: number;
  sourceUrl: string | null;
};

type ReactionEvent = {
  id: string;
  emoji: ReactionEmoji;
  source: 'user' | 'agent';
  createdAt: string;
  playbackTime: number | null;
  timecode: string | null;
  left: number;
};

type WebMcpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  execute: (input?: unknown) => unknown | Promise<unknown>;
};

type ModelContext = {
  registerTool: (tool: WebMcpTool) => void | Promise<void>;
  unregisterTool?: (name: string) => void | Promise<void>;
};

type YouTubePlayer = {
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  getPlayerState: () => number;
  destroy: () => void;
};

type YouTubeNamespace = {
  Player: new (
    element: HTMLElement,
    options: {
      videoId: string;
      playerVars: Record<string, string | number>;
      events: {
        onReady: (event: { target: YouTubePlayer }) => void;
        onStateChange: () => void;
        onError: () => void;
      };
    },
  ) => YouTubePlayer;
};

declare global {
  interface Document {
    modelContext?: ModelContext;
  }

  interface Window {
    YT?: YouTubeNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const EMPTY_PLAYBACK: PlaybackSnapshot = {
  sourceUrl: null,
  sourceKind: null,
  status: 'idle',
  currentTime: null,
  duration: null,
  controllable: false,
};

let youtubeApiPromise: Promise<YouTubeNamespace> | null = null;

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

async function waitForStatus(
  playbackRef: MutableRefObject<PlaybackSnapshot>,
  statuses: PlaybackStatus[],
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (statuses.includes(playbackRef.current.status)) return true;
    await wait(100);
  }
  return statuses.includes(playbackRef.current.status);
}

function finiteTime(value: number) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 10) / 10 : null;
}

function formatTimecode(value: number | null) {
  if (value === null || !Number.isFinite(value) || value < 0) return null;

  const totalTenths = Math.round(value * 10);
  const tenths = totalTenths % 10;
  const totalSeconds = Math.floor(totalTenths / 10);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths}`;
}

// Accepts "3600", "3600s", "1h2m3s" (YouTube's t= format), or clock style "1:02:03".
function parseTimeInput(value: string): number | null {
  const text = value.trim().toLowerCase();
  if (!text) return null;

  if (/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(text)) {
    return text.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  }

  const units = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(text);
  if (!units || !units.slice(1).some(Boolean)) return null;
  const [hours, minutes, seconds] = units.slice(1).map((part) => Number(part ?? 0));
  return hours * 3600 + minutes * 60 + seconds;
}

function signalWakeReason(signal: UserSignal): WakeReason {
  if (signal.kind === 'look') return 'look_request';
  if (signal.kind === 'mark') return 'mark_request';
  return 'user_signal';
}

function shortTimecode(value: number | null) {
  return formatTimecode(value)?.slice(0, -2) ?? '—';
}

function notesStorageKey(source: VideoSource) {
  return NOTES_KEY_PREFIX + (source.kind === 'youtube' ? source.videoId : source.url);
}

function loadStoredNotes(source: VideoSource): Note[] {
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(notesStorageKey(source)) ?? 'null',
    ) as StoredNotes | null;
    return Array.isArray(stored?.notes) ? stored.notes : [];
  } catch {
    return [];
  }
}

function noteWrittenLateSeconds(note: Note) {
  if (note.time === null || note.writtenAt === null) return 0;
  const late = note.writtenAt - note.time;
  return late > NOTE_LATE_SECONDS ? Math.round(late) : 0;
}

function noteLink(source: VideoSource, time: number | null) {
  if (time === null) return null;
  if (source.kind === 'youtube') {
    return `https://www.youtube.com/watch?v=${source.videoId}&t=${Math.floor(time)}s`;
  }
  return source.kind === 'direct' ? `${source.url.split('#')[0]}#t=${Math.floor(time)}` : null;
}

function notesToMarkdown(source: VideoSource, title: string | null, notes: Note[]) {
  const lines = [
    `# Notes: ${title ?? 'Untitled video'}`,
    '',
    `Source: ${source.url}`,
    `Exported: ${new Date().toLocaleString()}`,
    '',
  ];
  for (const note of [...notes].sort((a, b) => (a.time ?? 0) - (b.time ?? 0))) {
    const stamp = shortTimecode(note.time);
    const link = noteLink(source, note.time);
    const late = noteWrittenLateSeconds(note);
    const by =
      note.source === 'viewer' ? 'me' : note.source === 'mark' ? 'marked by me, described by GPT' : 'GPT';
    const details = [by, late ? `written ${late}s later` : null].filter(Boolean).join(', ');
    lines.push(
      `- **${link ? `[${stamp}](${link})` : stamp}** ${note.text || '(marked, no description yet)'} _(${details})_`,
    );
  }
  return lines.join('\n') + '\n';
}

function publicPlaybackState(snapshot: PlaybackSnapshot) {
  const currentTime = snapshot.currentTime === null ? null : finiteTime(snapshot.currentTime);
  const duration = snapshot.duration === null ? null : finiteTime(snapshot.duration);

  return {
    ...snapshot,
    currentTime,
    timecode: formatTimecode(currentTime),
    duration,
    durationTimecode: formatTimecode(duration),
  };
}

function readablePathSegment(value: string | undefined) {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function initialMediaMetadata(source: VideoSource, sessionId: string): MediaMetadata {
  if (source.kind === 'youtube') {
    return {
      sessionId,
      sourceKind: source.kind,
      sourceId: source.videoId,
      providerName: 'YouTube',
      title: null,
      authorName: null,
      publishedAt: null,
      viewCount: null,
      status: 'loading',
      missingFields: ['title', 'authorName', 'publishedAt', 'viewCount'],
    };
  }

  const url = new URL(source.url);
  const directTitle =
    source.kind === 'direct'
      ? readablePathSegment(url.pathname.split('/').filter(Boolean).at(-1))
      : null;

  return {
    sessionId,
    sourceKind: source.kind,
    sourceId: source.url,
    providerName: url.hostname || null,
    title: directTitle,
    authorName: null,
    publishedAt: null,
    viewCount: null,
    status: source.kind === 'direct' ? 'partial' : 'unavailable',
    missingFields: [
      ...(directTitle ? [] : ['title']),
      'authorName',
      'publishedAt',
      'viewCount',
    ],
  };
}

function webMcpError(code: string, message: string, snapshot: PlaybackSnapshot) {
  return {
    ok: false,
    error: { code, message },
    playback: publicPlaybackState(snapshot),
  };
}

function parseVideoSource(value: string): VideoSource {
  let url: URL;

  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Enter a complete video URL.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Only http and https video links are supported.');
  }

  if (url.origin === window.location.origin) {
    throw new Error('Paste a video URL, not the Watch with GPT site URL.');
  }

  const hostname = url.hostname.toLowerCase();
  const startParam =
    url.searchParams.get('t') ??
    url.searchParams.get('start') ??
    new URLSearchParams(url.hash.slice(1)).get('t');
  const startSeconds = startParam ? parseTimeInput(startParam) : null;
  const isYouTube =
    hostname === 'youtu.be' ||
    hostname === 'youtube.com' ||
    hostname.endsWith('.youtube.com') ||
    hostname === 'youtube-nocookie.com' ||
    hostname.endsWith('.youtube-nocookie.com');

  if (isYouTube) {
    const pathParts = url.pathname.split('/').filter(Boolean);
    const videoId =
      hostname === 'youtu.be'
        ? pathParts[0]
        : url.searchParams.get('v') ??
          (['embed', 'shorts', 'live'].includes(pathParts[0] ?? '') ? pathParts[1] : null);

    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      throw new Error('This YouTube link does not contain a valid video ID.');
    }

    return { kind: 'youtube', url: url.toString(), videoId, startSeconds };
  }

  if (/\.(mp4|webm|ogg|ogv|m4v|mov)$/i.test(url.pathname)) {
    return { kind: 'direct', url: url.toString(), startSeconds };
  }

  return { kind: 'embed', url: url.toString() };
}

function loadYouTubeApi() {
  if (window.YT?.Player) {
    return Promise.resolve(window.YT);
  }

  if (youtubeApiPromise) {
    return youtubeApiPromise;
  }

  youtubeApiPromise = new Promise<YouTubeNamespace>((resolve, reject) => {
    const previousReady = window.onYouTubeIframeAPIReady;
    const timeoutId = window.setTimeout(() => {
      reject(new Error('YouTube player API did not load.'));
    }, 12_000);

    window.onYouTubeIframeAPIReady = () => {
      previousReady?.();
      window.clearTimeout(timeoutId);
      if (window.YT?.Player) {
        resolve(window.YT);
      } else {
        reject(new Error('YouTube player API is unavailable.'));
      }
    };

    if (!document.querySelector('script[data-youtube-iframe-api]')) {
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.dataset.youtubeIframeApi = 'true';
      script.addEventListener(
        'error',
        () => {
          window.clearTimeout(timeoutId);
          reject(new Error('YouTube player API could not be loaded.'));
        },
        { once: true },
      );
      document.head.appendChild(script);
    }
  });

  return youtubeApiPromise;
}

function youtubeStatus(state: number): PlaybackStatus {
  if (state === 1) return 'playing';
  if (state === 2) return 'paused';
  if (state === 0) return 'ended';
  if (state === 3) return 'loading';
  return 'ready';
}

function YouTubeSurface({
  source,
  controllerRef,
  onPlayback,
}: {
  source: Extract<VideoSource, { kind: 'youtube' }>;
  controllerRef: MutableRefObject<PlayerController | null>;
  onPlayback: (snapshot: Partial<PlaybackSnapshot>) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let player: YouTubePlayer | null = null;
    let intervalId: number | null = null;

    onPlayback({ status: 'loading', controllable: false });

    void loadYouTubeApi()
      .then((youtube) => {
        if (disposed || !hostRef.current) return;

        const report = () => {
          if (!player || disposed) return;
          onPlayback({
            status: youtubeStatus(player.getPlayerState()),
            currentTime: finiteTime(player.getCurrentTime()),
            duration: finiteTime(player.getDuration()),
            controllable: true,
          });
        };

        player = new youtube.Player(hostRef.current, {
          videoId: source.videoId,
          playerVars: {
            autoplay: 0,
            controls: 1,
            enablejsapi: 1,
            playsinline: 1,
            rel: 0,
            origin: window.location.origin,
            ...(source.startSeconds ? { start: Math.floor(source.startSeconds) } : {}),
          },
          events: {
            onReady: (event) => {
              player = event.target;
              controllerRef.current = {
                play: async () => {
                  player?.playVideo();
                  return true;
                },
                pause: async () => {
                  player?.pauseVideo();
                  return true;
                },
                seek: (seconds) => player?.seekTo(seconds, true),
              };
              report();
              intervalId = window.setInterval(report, 250);
            },
            onStateChange: report,
            onError: () => {
              onPlayback({ status: 'unavailable', controllable: false });
            },
          },
        });
      })
      .catch(() => {
        if (!disposed) {
          onPlayback({ status: 'unavailable', controllable: false });
        }
      });

    return () => {
      disposed = true;
      controllerRef.current = null;
      if (intervalId !== null) window.clearInterval(intervalId);
      player?.destroy();
    };
  }, [controllerRef, onPlayback, source.startSeconds, source.videoId]);

  return <div className="youtube-host" ref={hostRef} />;
}

function DirectVideoSurface({
  source,
  controllerRef,
  onPlayback,
}: {
  source: Extract<VideoSource, { kind: 'direct' }>;
  controllerRef: MutableRefObject<PlayerController | null>;
  onPlayback: (snapshot: Partial<PlaybackSnapshot>) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  const report = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const status: PlaybackStatus = video.ended
      ? 'ended'
      : video.paused
        ? video.readyState >= 2
          ? 'paused'
          : 'loading'
        : 'playing';

    onPlayback({
      status,
      currentTime: finiteTime(video.currentTime),
      duration: finiteTime(video.duration),
      controllable: true,
    });
  }, [onPlayback]);

  useEffect(() => {
    controllerRef.current = {
      play: async () => {
        const video = videoRef.current;
        if (!video) return false;
        try {
          await video.play();
          return true;
        } catch {
          return false;
        }
      },
      pause: async () => {
        const video = videoRef.current;
        if (!video) return false;
        video.pause();
        return true;
      },
      seek: (seconds: number) => {
        if (videoRef.current) videoRef.current.currentTime = seconds;
      },
    };

    return () => {
      controllerRef.current = null;
    };
  }, [controllerRef]);

  return (
    <video
      ref={videoRef}
      src={source.url}
      controls
      playsInline
      preload="metadata"
      onLoadedMetadata={(event) => {
        if (source.startSeconds) event.currentTarget.currentTime = source.startSeconds;
        report();
      }}
      onCanPlay={report}
      onDurationChange={report}
      onEnded={report}
      onPause={report}
      onPlay={report}
      onTimeUpdate={report}
    />
  );
}

function PlayerSurface({
  source,
  controllerRef,
  onPlayback,
}: {
  source: VideoSource;
  controllerRef: MutableRefObject<PlayerController | null>;
  onPlayback: (snapshot: Partial<PlaybackSnapshot>) => void;
}) {
  useEffect(() => {
    if (source.kind === 'embed') {
      controllerRef.current = null;
      onPlayback({
        status: 'unavailable',
        currentTime: null,
        duration: null,
        controllable: false,
      });
    }
  }, [controllerRef, onPlayback, source.kind]);

  if (source.kind === 'youtube') {
    return (
      <YouTubeSurface
        source={source}
        controllerRef={controllerRef}
        onPlayback={onPlayback}
      />
    );
  }

  if (source.kind === 'direct') {
    return (
      <DirectVideoSurface
        source={source}
        controllerRef={controllerRef}
        onPlayback={onPlayback}
      />
    );
  }

  return (
    <iframe
      src={source.url}
      title="Shared video player"
      allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
      allowFullScreen
      referrerPolicy="strict-origin-when-cross-origin"
    />
  );
}

export default function Home() {
  const [videoUrl, setVideoUrl] = useState('');
  const [source, setSource] = useState<VideoSource | null>(null);
  const [error, setError] = useState('');
  const [reactions, setReactions] = useState<ReactionEvent[]>([]);
  const [reactionMenuOpen, setReactionMenuOpen] = useState(false);
  const [viewerReactionCoolingDown, setViewerReactionCoolingDown] = useState(false);
  const [playbackStatus, setPlaybackStatus] = useState<PlaybackStatus>('idle');
  const [mediaMetadata, setMediaMetadata] = useState<MediaMetadata | null>(null);
  const [observationIntervalSeconds, setObservationIntervalSeconds] =
    useState<ObservationIntervalSeconds>(DEFAULT_OBSERVATION_INTERVAL_SECONDS);
  const playbackRef = useRef<PlaybackSnapshot>(EMPTY_PLAYBACK);
  const mediaMetadataRef = useRef(mediaMetadata);
  const observationIntervalRef = useRef(observationIntervalSeconds);
  const controllerRef = useRef<PlayerController | null>(null);
  const reactionSequenceRef = useRef(0);
  const signalSequenceRef = useRef(0);
  const mediaSessionSequenceRef = useRef(0);
  const pendingSignalsRef = useRef<UserSignal[]>([]);
  const observationWaiterRef = useRef<ObservationWaiter | null>(null);
  const observationCursorRef = useRef<ObservationCursor | null>(null);
  const playbackSampleRef = useRef<PlaybackSample | null>(null);
  const reactionMenuRef = useRef<HTMLDivElement>(null);
  const lastViewerReactionAtRef = useRef(0);
  const viewerReactionCooldownTimerRef = useRef<number | null>(null);
  const [stopAtText, setStopAtText] = useState('');
  const [stopAtSeconds, setStopAtSeconds] = useState<number | null>(null);
  const stopAtRef = useRef<number | null>(null);
  const sourceStartRef = useRef<number | null>(null);
  // Armed while playback is before the stop time, so resuming past it is not re-paused.
  const stopArmedRef = useRef(false);
  const [plannedStartText, setPlannedStartText] = useState('');
  const [plannedStopText, setPlannedStopText] = useState('');
  const [lookMode, setLookMode] = useState<LookMode>(DEFAULT_LOOK_MODE);
  const lookModeRef = useRef<LookMode>(DEFAULT_LOOK_MODE);
  // Play/pause/seek events not yet reported to the agent.
  const timelineRef = useRef<TimelineEvent[]>([]);
  // Last settled status (playing, paused, ended), ignoring buffering blips.
  const settledStatusRef = useRef<PlaybackStatus | null>(null);
  const pausedSinceRef = useRef<number | null>(null);
  // When the current run of observer calls began; a gap of over a minute starts a new run.
  const loopStartedAtRef = useRef(0);
  const lastObserveAtRef = useRef(0);
  const observationSeqRef = useRef(0);
  const [observerStatus, setObserverStatus] = useState<ObserverStatus>({
    waiting: false,
    endedAt: 0,
    last: null,
  });
  const [statusNow, setStatusNow] = useState(0);
  // Shown inside .player-frame when a look is requested, so the captured image
  // carries its own sequence number and timecode.
  const [captureBadge, setCaptureBadge] = useState<{ seq: number; timecode: string | null } | null>(
    null,
  );
  const captureBadgeTimerRef = useRef<number | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const notesRef = useRef<Note[]>([]);
  const [notesOpen, setNotesOpen] = useState(true);
  const [noteDraft, setNoteDraft] = useState('');
  const [notesMessage, setNotesMessage] = useState('');
  const noteSequenceRef = useRef(0);
  const sourceRef = useRef<VideoSource | null>(null);

  // Single place notes change: updates state, the ref the tools read, and storage.
  const commitNotes = useCallback((next: Note[]) => {
    notesRef.current = next;
    setNotes(next);
    const currentSource = sourceRef.current;
    if (!currentSource) return;
    try {
      const stored: StoredNotes = {
        title: mediaMetadataRef.current?.title ?? null,
        url: currentSource.url,
        notes: next,
      };
      window.localStorage.setItem(notesStorageKey(currentSource), JSON.stringify(stored));
    } catch {
      setNotesMessage('Notes could not be saved in this browser. Download them to keep a copy.');
    }
  }, []);

  const createNote = useCallback(
    (fields: Pick<Note, 'text' | 'source'> & Partial<Pick<Note, 'time' | 'observationSeq'>>) => {
      const now = finiteTime(playbackRef.current.currentTime ?? Number.NaN);
      const note: Note = {
        id: `note-${Date.now()}-${noteSequenceRef.current++}`,
        time: fields.time === undefined ? now : fields.time,
        writtenAt: fields.source === 'mark' ? null : now,
        text: fields.text.slice(0, MAX_NOTE_LENGTH),
        source: fields.source,
        observationSeq: fields.observationSeq ?? null,
        createdAt: new Date().toISOString(),
      };
      commitNotes([...notesRef.current, note]);
      return note;
    },
    [commitNotes],
  );

  const changeStopAt = useCallback((text: string) => {
    const seconds = parseTimeInput(text);
    setStopAtText(text);
    setStopAtSeconds(seconds);
    stopAtRef.current = seconds;
    stopArmedRef.current = false;
  }, []);

  const changeLookMode = useCallback(
    (mode: LookMode, intervalSeconds?: ObservationIntervalSeconds) => {
      setLookMode(mode);
      lookModeRef.current = mode;
      if (intervalSeconds) {
        setObservationIntervalSeconds(intervalSeconds);
        observationIntervalRef.current = intervalSeconds;
      }
      // Restart the schedule from the current position under the new mode.
      if (observationCursorRef.current) observationCursorRef.current.nextCheckpointTime = null;
      try {
        window.localStorage.setItem(
          LOOK_SETTINGS_KEY,
          JSON.stringify({ mode, intervalSeconds: observationIntervalRef.current }),
        );
      } catch {
        // Storage can be unavailable (private window); the setting just won't persist.
      }
    },
    [],
  );

  // Called when a video opens; the look controls only exist on the watch screen.
  const restoreLookMode = useCallback(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(LOOK_SETTINGS_KEY) ?? 'null') as {
        mode?: unknown;
        intervalSeconds?: unknown;
      } | null;
      if (saved && ['request', 'moments', 'interval'].includes(saved.mode as string)) {
        const interval = OBSERVATION_INTERVALS_SECONDS.includes(
          saved.intervalSeconds as ObservationIntervalSeconds,
        )
          ? (saved.intervalSeconds as ObservationIntervalSeconds)
          : undefined;
        changeLookMode(saved.mode as LookMode, interval);
      }
    } catch {
      // Ignore unreadable storage and keep the current mode.
    }
  }, [changeLookMode]);

  // Tick so the observer status line can age "responding" into "not following".
  useEffect(() => {
    if (!observerStatus.last) return;
    const intervalId = window.setInterval(() => setStatusNow(Date.now()), 5_000);
    return () => window.clearInterval(intervalId);
  }, [observerStatus.last]);

  const pushTimeline = useCallback((event: TimelineEvent) => {
    timelineRef.current = [...timelineRef.current.slice(-19), event];
  }, []);

  useEffect(() => {
    mediaMetadataRef.current = mediaMetadata;
  }, [mediaMetadata]);

  useEffect(() => {
    observationIntervalRef.current = observationIntervalSeconds;
  }, [observationIntervalSeconds]);

  useEffect(() => {
    if (!source || source.kind !== 'youtube') return;

    const sessionId = mediaMetadataRef.current?.sessionId;
    let disposed = false;
    void fetch(`/api/youtube-metadata?videoId=${encodeURIComponent(source.videoId)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error('YouTube metadata is unavailable.');
        return (await response.json()) as {
          title?: unknown;
          authorName?: unknown;
        };
      })
      .then((metadata) => {
        if (disposed) return;
        setMediaMetadata((current) => {
          if (!current || current.sessionId !== sessionId) return current;
          const title = typeof metadata.title === 'string' ? metadata.title : null;
          const authorName =
            typeof metadata.authorName === 'string' ? metadata.authorName : null;
          return {
            ...current,
            title,
            authorName,
            status: title ? 'partial' : 'unavailable',
            missingFields: [
              ...(title ? [] : ['title']),
              ...(authorName ? [] : ['authorName']),
              'publishedAt',
              'viewCount',
            ],
          };
        });
      })
      .catch(() => {
        if (disposed) return;
        setMediaMetadata((current) =>
          current && current.sessionId === sessionId
            ? { ...current, status: 'unavailable' }
            : current,
        );
      });

    return () => {
      disposed = true;
    };
  }, [source]);

  useEffect(() => {
    if (!reactionMenuOpen) return;

    const closeOnOutsidePress = (event: PointerEvent) => {
      if (
        reactionMenuRef.current &&
        event.target instanceof Node &&
        !reactionMenuRef.current.contains(event.target)
      ) {
        setReactionMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setReactionMenuOpen(false);
    };

    document.addEventListener('pointerdown', closeOnOutsidePress);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [reactionMenuOpen]);

  useEffect(
    () => () => {
      if (viewerReactionCooldownTimerRef.current !== null) {
        window.clearTimeout(viewerReactionCooldownTimerRef.current);
      }
    },
    [],
  );

  const updatePlayback = useCallback((next: Partial<PlaybackSnapshot>) => {
    const previous = playbackRef.current;
    const current = { ...previous, ...next };
    const sampledAt = performance.now();

    if (current.currentTime !== null) {
      const previousSample = playbackSampleRef.current;
      // Before first play, the player jumping to a start time is not a seek.
      if (
        previousSample &&
        previousSample.sourceUrl === current.sourceUrl &&
        settledStatusRef.current !== null
      ) {
        const wallDeltaSeconds = Math.max(0, (sampledAt - previousSample.sampledAt) / 1_000);
        const mediaDeltaSeconds = current.currentTime - previousSample.mediaTime;
        // Playing media advances with the clock (allowing fast playback rates);
        // otherwise it should barely move, so any jump is a seek.
        const largestExpectedAdvance =
          previous.status === 'playing' ? Math.max(2, wallDeltaSeconds * 4 + 1) : 1.5;
        if (mediaDeltaSeconds < -1 || mediaDeltaSeconds > largestExpectedAdvance) {
          pushTimeline({
            type: 'seeked',
            fromTimecode: formatTimecode(previousSample.mediaTime),
            timecode: formatTimecode(current.currentTime),
          });
          if (observationCursorRef.current && lookModeRef.current !== 'request') {
            observationCursorRef.current.nextCheckpointTime =
              current.currentTime + SEEK_SETTLE_SECONDS;
          }
        }
      }

      playbackSampleRef.current = {
        mediaTime: current.currentTime,
        sampledAt,
        sourceUrl: current.sourceUrl,
      };
    }

    const settled = settledStatusRef.current;
    if (
      (current.status === 'playing' || current.status === 'paused' || current.status === 'ended') &&
      current.status !== settled
    ) {
      const timecode = formatTimecode(current.currentTime);
      if (current.status === 'playing') {
        pushTimeline({ type: settled === null ? 'started' : 'resumed', timecode });
      } else {
        pushTimeline({ type: current.status, timecode });
      }
      settledStatusRef.current = current.status;
    }
    if (current.status === 'playing') {
      pausedSinceRef.current = null;
    } else if (pausedSinceRef.current === null) {
      pausedSinceRef.current = Date.now();
    }

    const stopAt = stopAtRef.current;
    if (stopAt !== null && current.currentTime !== null) {
      if (current.currentTime < stopAt - 1) {
        stopArmedRef.current = true;
      } else if (
        stopArmedRef.current &&
        current.status === 'playing' &&
        current.currentTime >= stopAt
      ) {
        stopArmedRef.current = false;
        pushTimeline({ type: 'stop_at', timecode: formatTimecode(stopAt) });
        void controllerRef.current?.pause();
      }
    }

    playbackRef.current = current;
    if (current.status !== previous.status) {
      setPlaybackStatus(current.status);
    }
  }, [pushTimeline]);

  const publishVisualReactions = useCallback(
    (emojis: readonly ReactionEmoji[], eventSource: 'user' | 'agent') => {
      const createdAt = new Date().toISOString();
      const playbackTime = finiteTime(playbackRef.current.currentTime ?? Number.NaN);
      const events = emojis.map((emoji) => {
        const sequence = reactionSequenceRef.current++;
        return {
          id: `${Date.now()}-${sequence}`,
          emoji,
          source: eventSource,
          createdAt,
          playbackTime,
          timecode: formatTimecode(playbackTime),
          left: 28 + ((sequence * 17) % 45),
        } satisfies ReactionEvent;
      });
      const eventIds = new Set(events.map((event) => event.id));

      setReactions((current) => [...current, ...events]);
      window.setTimeout(() => {
        setReactions((current) => current.filter((reaction) => !eventIds.has(reaction.id)));
      }, 2_200);

      return events;
    },
    [],
  );

  const releaseObservation = useCallback((wake: ObservationWake) => {
    const waiter = observationWaiterRef.current;
    if (!waiter) {
      return false;
    }

    window.clearTimeout(waiter.timerId);
    observationWaiterRef.current = null;
    waiter.resolve(wake);
    return true;
  }, []);

  const publishUserSignal = useCallback(
    (kind: UserSignal['kind'], emoji: ReactionEmoji | null = null, markId?: string) => {
      const playbackTime = finiteTime(playbackRef.current.currentTime ?? Number.NaN);
      const signal: UserSignal = {
        id: `signal-${Date.now()}-${signalSequenceRef.current++}`,
        kind,
        emoji,
        ...(markId ? { markId } : {}),
        createdAt: new Date().toISOString(),
        playbackTime,
        timecode: formatTimecode(playbackTime),
      };

      if (!releaseObservation({ reason: signalWakeReason(signal), signal })) {
        pendingSignalsRef.current = [...pendingSignalsRef.current.slice(-19), signal];
      }
    },
    [releaseObservation],
  );

  const publishUserReaction = useCallback(
    (emoji: ReactionEmoji) => {
      const now = Date.now();
      if (now - lastViewerReactionAtRef.current < VIEWER_REACTION_COOLDOWN_MS) return;

      lastViewerReactionAtRef.current = now;
      setViewerReactionCoolingDown(true);
      if (viewerReactionCooldownTimerRef.current !== null) {
        window.clearTimeout(viewerReactionCooldownTimerRef.current);
      }
      viewerReactionCooldownTimerRef.current = window.setTimeout(() => {
        setViewerReactionCoolingDown(false);
        viewerReactionCooldownTimerRef.current = null;
      }, VIEWER_REACTION_COOLDOWN_MS);

      publishVisualReactions([emoji], 'user');
      publishUserSignal('emoji', emoji);
    },
    [publishUserSignal, publishVisualReactions],
  );

  // Polls page state every 100 ms and resolves on the first reason to wake the agent.
  // Signals that arrive while no call is pending are queued and returned at once.
  const waitForObservationWake = useCallback((observedSource: string) => {
    const startedAt = Date.now();

    const nextWake = (): ObservationWake | null => {
      const current = playbackRef.current;
      if (current.sourceUrl !== observedSource) return { reason: 'session_changed' };

      const queuedSignal = pendingSignalsRef.current.shift();
      if (queuedSignal) {
        return { reason: signalWakeReason(queuedSignal), signal: queuedSignal };
      }

      const events = timelineRef.current;
      if (events.some((event) => event.type === 'stop_at')) return { reason: 'stop_at' };
      if (events.some((event) => event.type === 'ended')) return { reason: 'ended' };

      const cursor = observationCursorRef.current;
      const mode = lookModeRef.current;
      if (
        mode !== 'request' &&
        current.status === 'playing' &&
        current.currentTime !== null &&
        cursor?.nextCheckpointTime != null &&
        current.currentTime >= cursor.nextCheckpointTime
      ) {
        return { reason: mode === 'interval' ? 'interval' : 'key_moment', signal: null };
      }

      if (events.length > 0) return { reason: 'playback_event', signal: null };

      if (
        pausedSinceRef.current !== null &&
        Date.now() - Math.max(pausedSinceRef.current, loopStartedAtRef.current) > PAUSE_LIMIT_MS
      ) {
        return { reason: 'paused_too_long' };
      }
      if (Date.now() - startedAt > OBSERVER_HEARTBEAT_MS) {
        return { reason: 'heartbeat', signal: null };
      }
      return null;
    };

    const immediate = nextWake();
    if (immediate) return Promise.resolve(immediate);

    return new Promise<ObservationWake>((resolve) => {
      const check = () => {
        const waiter = observationWaiterRef.current;
        if (!waiter || waiter.resolve !== resolve) return;

        const wake = nextWake();
        if (wake) {
          observationWaiterRef.current = null;
          resolve(wake);
          return;
        }
        waiter.timerId = window.setTimeout(check, 100);
      };

      observationWaiterRef.current = { timerId: window.setTimeout(check, 100), resolve };
    });
  }, []);

  useEffect(() => {
    const modelContext = document.modelContext;
    if (!modelContext?.registerTool) {
      document.documentElement.dataset.siteTools = 'unavailable';
      return;
    }

    const noInputSchema = {
      type: 'object',
      properties: {},
      additionalProperties: false,
    };

    const tools: WebMcpTool[] = [
      {
        name: 'watch_get_session',
        description:
          'Read the current shared-video state, session-level media metadata, and viewing protocol. Call this before starting a watch-along. The user’s current request determines the interaction style; do not assume they want constant commentary.',
        inputSchema: noInputSchema,
        annotations: { readOnlyHint: true },
        execute: async () => ({
          ok: true,
          media: mediaMetadataRef.current,
          playback: publicPlaybackState(playbackRef.current),
          protocol: {
            ...WATCH_PROTOCOL,
            lookMode: lookModeRef.current,
            observationIntervalSeconds: observationIntervalRef.current,
            keyMomentFallbackSeconds: KEY_MOMENT_FALLBACK_SECONDS,
            viewerReactionCooldownSeconds: VIEWER_REACTION_COOLDOWN_MS / 1_000,
            maxAgentReactionsPerCall: MAX_AGENT_REACTIONS,
            startTimecode: formatTimecode(sourceStartRef.current ?? Number.NaN),
            stopAtTimecode: formatTimecode(stopAtRef.current ?? Number.NaN),
            stopAt:
              'When stopAtTimecode is set, the page pauses playback there and the observer returns STOP_AT_REACHED; end the loop and tell the viewer.',
            mediaMetadata:
              'watch_get_session returns session-level media identity once. Observations are compact: wake reason, capture flag, status, timecode, any play/pause/seek events, and a short "next" reminder. If the video changes, the observer returns SESSION_CHANGED.',
            liveSignals:
              'A viewer emoji or Look now press wakes watch_observe_next_moment immediately with capture: true. It is intentional input inside the active watch-along, never an implicit request to pause or stop. Acknowledge it from the frame and conversation context, then continue observing in the same turn.',
            visualCapture:
              'Capture .player-frame only when observation.capture is true, or when the viewer asks you to look. Capture in the same programmatic browser call that awaited the observer, with no model reasoning in between. The frame includes the video, captions, and player overlays.',
          },
        }),
      },
      {
        name: 'watch_get_status',
        description:
          'Cheap check of the current playback state, look mode, and stop-at time. Use this instead of watch_get_session to confirm whether the video is moving.',
        inputSchema: noInputSchema,
        annotations: { readOnlyHint: true },
        execute: async () => {
          const current = playbackRef.current;
          return {
            ok: true,
            status: current.status,
            timecode: formatTimecode(current.currentTime),
            durationTimecode: formatTimecode(current.duration),
            lookMode: lookModeRef.current,
            ...(lookModeRef.current === 'interval'
              ? { intervalSeconds: observationIntervalRef.current }
              : {}),
            stopAtTimecode: formatTimecode(stopAtRef.current ?? Number.NaN),
            lastObservationSeq: observationSeqRef.current,
            observerWaiting: observationWaiterRef.current !== null,
          };
        },
      },
      {
        name: 'watch_observe_next_moment',
        description:
          'Continue an active watch-along. Run it inside one programmatic browser call: await this tool, and if observation.capture is true, capture the rendered .player-frame in the very next browser operation; return the observation (and image, if captured) together with no model reasoning in between. When capture is false, do not capture. The observer waits through pauses and wakes on the look-mode schedule, a viewer Look now request or emoji, play/pause/seek events (listed in observation.events), or a 30-second heartbeat. Use the frame and conversation to decide whether to stay quiet, react, or comment; always acknowledge a viewer emoji or look request. Keep calling it in the same turn until the user asks you to stop or it returns an error (ok: false). A new call safely replaces a pending one.',
        inputSchema: noInputSchema,
        annotations: { readOnlyHint: true },
        execute: async () => {
          const initial = playbackRef.current;
          if (!initial.sourceUrl) {
            return webMcpError('NO_VIDEO', 'No video is open.', initial);
          }
          if (initial.sourceKind === 'embed') {
            return webMcpError(
              'PLAYER_STATE_UNAVAILABLE',
              'This embedded player does not expose playback timing to the page.',
              initial,
            );
          }

          // A newer call replaces a stale pending one (for example after the
          // viewer interrupted by voice) instead of failing.
          releaseObservation({ reason: 'cancelled' });

          const now = Date.now();
          if (now - lastObserveAtRef.current > 60_000) loopStartedAtRef.current = now;
          lastObserveAtRef.current = now;

          const observedSource = initial.sourceUrl;
          if (observationCursorRef.current?.sourceUrl !== observedSource) {
            observationCursorRef.current = { sourceUrl: observedSource, nextCheckpointTime: null };
          }
          const cursor = observationCursorRef.current;
          const period =
            lookModeRef.current === 'interval'
              ? observationIntervalRef.current
              : KEY_MOMENT_FALLBACK_SECONDS;
          if (cursor.nextCheckpointTime === null && initial.currentTime !== null) {
            // Take a first look soon after the watch-along starts.
            cursor.nextCheckpointTime = initial.currentTime + Math.min(period, 5);
          }

          setObserverStatus((status) => ({ ...status, waiting: true }));
          const wake = await waitForObservationWake(observedSource);
          lastObserveAtRef.current = Date.now();
          const current = playbackRef.current;
          // A superseded call leaves the newer call's waiting state alone.
          if (wake.reason !== 'cancelled') {
            setObserverStatus((status) => ({ ...status, waiting: false, endedAt: Date.now() }));
          }
          if (wake.reason === 'cancelled') {
            return webMcpError(
              'OBSERVATION_SUPERSEDED',
              'This call was replaced by a newer observer call or cancelled by the page. If you did not start a newer call, call watch_get_session.',
              current,
            );
          }

          const events = timelineRef.current;
          timelineRef.current = [];
          if (wake.reason === 'session_changed') {
            return webMcpError(
              'SESSION_CHANGED',
              'The user changed the video. Call watch_get_session before observing again.',
              current,
            );
          }
          if (wake.reason === 'stop_at') {
            return webMcpError(
              'STOP_AT_REACHED',
              `Paused at the viewer's stop-at time (${formatTimecode(stopAtRef.current)}). Stop the observation loop and let the viewer know.`,
              current,
            );
          }
          if (wake.reason === 'ended') {
            return webMcpError('PLAYBACK_ENDED', 'The video ended. Stop the observation loop.', current);
          }
          if (wake.reason === 'paused_too_long') {
            return webMcpError(
              'PAUSED_TOO_LONG',
              'Playback has been paused for over 10 minutes. Stop the observation loop; the viewer can ask you to resume watching.',
              current,
            );
          }

          const capture = CAPTURE_WAKES.includes(wake.reason);
          if (capture && current.currentTime !== null) {
            cursor.nextCheckpointTime = current.currentTime + period;
          }
          const seq = ++observationSeqRef.current;
          const timecode = formatTimecode(current.currentTime);
          setObserverStatus({
            waiting: false,
            endedAt: Date.now(),
            last: { seq, reason: wake.reason as WakeReason, capture, timecode },
          });
          if (capture) {
            setCaptureBadge({ seq, timecode });
            if (captureBadgeTimerRef.current !== null) {
              window.clearTimeout(captureBadgeTimerRef.current);
            }
            captureBadgeTimerRef.current = window.setTimeout(() => setCaptureBadge(null), 4_000);
          }

          // Kept deliberately small: this payload repeats all session and
          // accumulates in the conversation. The full protocol lives in
          // watch_get_session and the tool description, which are sent once.
          const signal = 'signal' in wake ? wake.signal : null;
          return {
            ok: true,
            observation: {
              seq,
              wakeReason: wake.reason,
              capture,
              status: current.status,
              timecode,
              ...(signal?.emoji ? { signal: { emoji: signal.emoji, timecode: signal.timecode } } : {}),
              ...(signal?.markId ? { markId: signal.markId, markTimecode: signal.timecode } : {}),
              ...(events.length > 0 ? { events } : {}),
              next: NEXT_STEP[wake.reason as WakeReason],
            },
          };
        },
      },
      {
        name: 'watch_play',
        description:
          'Start or resume the shared video when the user asks. This changes visible playback. It fails explicitly when the embedded player does not expose controls.',
        inputSchema: noInputSchema,
        execute: async () => {
          const controller = controllerRef.current;
          if (!controller) {
            return webMcpError(
              'PLAYER_NOT_CONTROLLABLE',
              'This player does not expose playback controls to the page.',
              playbackRef.current,
            );
          }
          const requestedAt = performance.now();
          const played = await controller.play();
          if (!played) {
            return webMcpError(
              'PLAY_REJECTED',
              'The browser or player rejected playback.',
              playbackRef.current,
            );
          }
          // YouTube buffers briefly before playing; report the settled state.
          const playing = await waitForStatus(playbackRef, ['playing'], 6_000);
          return playing
            ? {
                ok: true,
                confirmedInMs: Math.round(performance.now() - requestedAt),
                playback: publicPlaybackState(playbackRef.current),
              }
            : webMcpError(
                'PLAY_NOT_STARTED',
                'Play was requested but the video has not started yet (still buffering, or the browser blocked autoplay). Ask the viewer to press play.',
                playbackRef.current,
              );
        },
      },
      {
        name: 'watch_pause',
        description:
          'Pause the shared video when the user asks or before a longer response would compete with playback. This changes visible playback. It fails explicitly when the embedded player does not expose controls.',
        inputSchema: noInputSchema,
        execute: async () => {
          const controller = controllerRef.current;
          if (!controller) {
            return webMcpError(
              'PLAYER_NOT_CONTROLLABLE',
              'This player does not expose playback controls to the page.',
              playbackRef.current,
            );
          }
          const requestedAt = performance.now();
          const paused =
            (await controller.pause()) &&
            (await waitForStatus(playbackRef, ['paused', 'ended'], 2_000));
          return paused
            ? {
                ok: true,
                confirmedInMs: Math.round(performance.now() - requestedAt),
                playback: publicPlaybackState(playbackRef.current),
              }
            : webMcpError(
                'PAUSE_REJECTED',
                'The player rejected the pause request.',
                playbackRef.current,
              );
        },
      },
      {
        name: 'watch_configure',
        description:
          'Change watch settings when the viewer asks, e.g. "only look when I ask" (lookMode request), "look at key moments" (moments), "check every 10 seconds" (interval + intervalSeconds), or "stop at one hour" (stopAt "1:00:00"; empty string clears it). This visibly updates the page controls.',
        inputSchema: {
          type: 'object',
          properties: {
            lookMode: { type: 'string', enum: ['request', 'moments', 'interval'] },
            intervalSeconds: { type: 'number', enum: OBSERVATION_INTERVALS_SECONDS },
            stopAt: {
              type: 'string',
              description: 'Time to pause at, like "1:00:00", "45m", or "3600". Empty clears it.',
            },
          },
          additionalProperties: false,
        },
        execute: async (input) => {
          const options = (typeof input === 'object' && input !== null ? input : {}) as {
            lookMode?: unknown;
            intervalSeconds?: unknown;
            stopAt?: unknown;
          };
          const lookModeInput = options.lookMode;
          const intervalInput = options.intervalSeconds;
          const stopAtInput = options.stopAt;

          if (
            lookModeInput !== undefined &&
            !['request', 'moments', 'interval'].includes(lookModeInput as string)
          ) {
            return webMcpError('INVALID_OPTION', 'lookMode must be request, moments, or interval.', playbackRef.current);
          }
          if (
            intervalInput !== undefined &&
            !OBSERVATION_INTERVALS_SECONDS.includes(intervalInput as ObservationIntervalSeconds)
          ) {
            return webMcpError('INVALID_OPTION', 'intervalSeconds must be 5, 10, or 15.', playbackRef.current);
          }
          if (
            stopAtInput !== undefined &&
            (typeof stopAtInput !== 'string' ||
              (stopAtInput.trim() !== '' && parseTimeInput(stopAtInput) === null))
          ) {
            return webMcpError('INVALID_OPTION', 'stopAt must look like "1:00:00", "45m", or "3600".', playbackRef.current);
          }

          if (lookModeInput !== undefined || intervalInput !== undefined) {
            changeLookMode(
              (lookModeInput as LookMode | undefined) ??
                (intervalInput !== undefined ? 'interval' : lookModeRef.current),
              intervalInput as ObservationIntervalSeconds | undefined,
            );
          }
          if (typeof stopAtInput === 'string') changeStopAt(stopAtInput);

          return {
            ok: true,
            lookMode: lookModeRef.current,
            intervalSeconds: observationIntervalRef.current,
            stopAtTimecode: formatTimecode(stopAtRef.current ?? Number.NaN),
          };
        },
      },
      {
        name: 'watch_add_note',
        description:
          'Save a timestamped note in the viewer\'s notes panel. Use it when the viewer says "mark this", "note that…", or asks you to remember something, and to describe a moment the viewer marked (pass the observation\'s markId). If you are writing about an earlier moment, pass its timecode so the note points there; the page labels notes written well after their moment. Keep notes short and factual. This visibly changes the page and is saved.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The note, ideally one or two sentences.' },
            markId: {
              type: 'string',
              description: 'markId from a mark_request observation, to describe that mark.',
            },
            timecode: {
              type: 'string',
              description: 'Moment the note is about, e.g. "00:01:34.3". Defaults to now.',
            },
            observationSeq: {
              type: 'number',
              description: 'seq of the observation whose frame this note describes, if any.',
            },
          },
          required: ['text'],
          additionalProperties: false,
        },
        execute: async (input) => {
          if (!sourceRef.current) {
            return webMcpError('NO_VIDEO', 'No video is open.', playbackRef.current);
          }
          const options = (typeof input === 'object' && input !== null ? input : {}) as {
            text?: unknown;
            markId?: unknown;
            timecode?: unknown;
            observationSeq?: unknown;
          };
          const text = typeof options.text === 'string' ? options.text.trim() : '';
          if (!text) {
            return webMcpError('INVALID_NOTE', 'text is required.', playbackRef.current);
          }
          const observationSeq =
            typeof options.observationSeq === 'number' ? options.observationSeq : null;
          const now = finiteTime(playbackRef.current.currentTime ?? Number.NaN);

          if (typeof options.markId === 'string') {
            const mark = notesRef.current.find((note) => note.id === options.markId);
            if (!mark) {
              return webMcpError('MARK_NOT_FOUND', 'No mark with that markId exists.', playbackRef.current);
            }
            const described: Note = {
              ...mark,
              text: text.slice(0, MAX_NOTE_LENGTH),
              writtenAt: now,
              observationSeq: observationSeq ?? mark.observationSeq,
            };
            commitNotes(notesRef.current.map((note) => (note.id === mark.id ? described : note)));
            return { ok: true, noteId: described.id, timecode: formatTimecode(described.time) };
          }

          let time = now;
          if (typeof options.timecode === 'string' && options.timecode.trim()) {
            time = parseTimeInput(options.timecode);
            if (time === null) {
              return webMcpError(
                'INVALID_NOTE',
                'timecode must look like "00:01:34.3", "1:34", or "94".',
                playbackRef.current,
              );
            }
          }
          const note = createNote({ text, source: 'gpt', time, observationSeq });
          return { ok: true, noteId: note.id, timecode: formatTimecode(note.time) };
        },
      },
      {
        name: 'watch_get_notes',
        description:
          'Read the viewer\'s notes for this video, oldest moment first. Use it to recall what was noted earlier, for example after the conversation has lost older context.',
        inputSchema: noInputSchema,
        annotations: { readOnlyHint: true },
        execute: async () => ({
          ok: true,
          notes: [...notesRef.current]
            .sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
            .map((note) => ({
              id: note.id,
              timecode: formatTimecode(note.time),
              text: note.text || null,
              by: note.source,
              ...(noteWrittenLateSeconds(note)
                ? { writtenLaterSeconds: noteWrittenLateSeconds(note) }
                : {}),
            })),
        }),
      },
      {
        name: 'watch_react',
        description:
          'Publish between one and five lightweight visual reactions together at the current playback moment. Use a small burst only when it genuinely fits or the user requests it; do not react to every observation. The user’s requested viewing style has priority. This visibly changes the page.',
        inputSchema: {
          type: 'object',
          properties: {
            emojis: {
              type: 'array',
              items: {
                type: 'string',
                enum: REACTION_EMOJIS,
              },
              minItems: 1,
              maxItems: MAX_AGENT_REACTIONS,
              description: 'One to five reactions to show together over the video.',
            },
          },
          required: ['emojis'],
          additionalProperties: false,
        },
        execute: async (input) => {
          if (!playbackRef.current.sourceUrl) {
            return webMcpError('NO_VIDEO', 'No video is open.', playbackRef.current);
          }

          const emojis =
            typeof input === 'object' && input !== null && 'emojis' in input
              ? (input as { emojis?: unknown }).emojis
              : undefined;

          if (
            !Array.isArray(emojis) ||
            emojis.length < 1 ||
            emojis.length > MAX_AGENT_REACTIONS ||
            !emojis.every((emoji) => REACTION_EMOJIS.includes(emoji as ReactionEmoji))
          ) {
            return webMcpError(
              'INVALID_REACTION',
              `Choose between one and ${MAX_AGENT_REACTIONS} reactions declared by this tool.`,
              playbackRef.current,
            );
          }

          const reactionEvents = publishVisualReactions(emojis as ReactionEmoji[], 'agent');
          return {
            ok: true,
            reactions: reactionEvents.map((reaction) => ({
              emoji: reaction.emoji,
              createdAt: reaction.createdAt,
              playbackTime: reaction.playbackTime,
              timecode: reaction.timecode,
              source: reaction.source,
            })),
            playback: publicPlaybackState(playbackRef.current),
          };
        },
      },
    ];

    document.documentElement.dataset.siteTools = 'registering';
    void Promise.all(tools.map((tool) => modelContext.registerTool(tool)))
      .then(() => {
        document.documentElement.dataset.siteTools = 'ready';
      })
      .catch(() => {
        document.documentElement.dataset.siteTools = 'error';
      });

    return () => {
      releaseObservation({ reason: 'cancelled' });
      if (modelContext.unregisterTool) {
        for (const tool of tools) {
          void modelContext.unregisterTool(tool.name);
        }
      }
      delete document.documentElement.dataset.siteTools;
    };
  }, [
    changeLookMode,
    changeStopAt,
    commitNotes,
    createNote,
    publishVisualReactions,
    releaseObservation,
    waitForObservationWake,
  ]);

  function markMoment() {
    const mark = createNote({ text: '', source: 'mark' });
    setNotesOpen(true);
    publishUserSignal('mark', null, mark.id);
  }

  function addViewerNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = noteDraft.trim();
    if (!text) return;
    createNote({ text, source: 'viewer' });
    setNoteDraft('');
  }

  function deleteNote(id: string) {
    commitNotes(notesRef.current.filter((note) => note.id !== id));
  }

  function jumpToNote(note: Note) {
    if (note.time !== null) controllerRef.current?.seek(note.time);
  }

  function notesMarkdown() {
    return source ? notesToMarkdown(source, mediaMetadata?.title ?? null, notesRef.current) : '';
  }

  function downloadNotes() {
    const title = mediaMetadata?.title ?? 'video';
    const fileName = `${title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'video'}-notes.md`;
    const url = URL.createObjectURL(new Blob([notesMarkdown()], { type: 'text/markdown' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  async function copyNotes() {
    try {
      await navigator.clipboard.writeText(notesMarkdown());
      setNotesMessage('Copied as Markdown.');
    } catch {
      setNotesMessage('Copy was blocked by the browser. Use Download instead.');
    }
  }

  function resetTimeline() {
    setObserverStatus({ waiting: false, endedAt: 0, last: null });
    setCaptureBadge(null);
    observationCursorRef.current = null;
    timelineRef.current = [];
    settledStatusRef.current = null;
    pausedSinceRef.current = null;
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const linkedSource = parseVideoSource(videoUrl);
      const plannedStart = parseTimeInput(plannedStartText);
      const plannedStop = parseTimeInput(plannedStopText);
      if (plannedStartText.trim() && plannedStart === null) {
        throw new Error('Start time should look like 1:00:00, 45m, or 3600.');
      }
      if (plannedStopText.trim() && plannedStop === null) {
        throw new Error('Stop time should look like 1:00:00, 45m, or 3600.');
      }
      // A start time typed here wins over a t= in the link.
      const parsedSource: VideoSource =
        linkedSource.kind !== 'embed' && plannedStart !== null
          ? { ...linkedSource, startSeconds: plannedStart }
          : linkedSource;
      const effectiveStart =
        parsedSource.kind === 'embed' ? null : (parsedSource.startSeconds ?? 0);
      if (plannedStop !== null && effectiveStart !== null && plannedStop <= effectiveStart) {
        throw new Error('Stop time must be after the start time.');
      }
      const sessionId = `media-${Date.now()}-${mediaSessionSequenceRef.current++}`;
      const nextMetadata = initialMediaMetadata(parsedSource, sessionId);
      const nextPlayback: PlaybackSnapshot = {
        sourceUrl: parsedSource.url,
        sourceKind: parsedSource.kind,
        status: parsedSource.kind === 'embed' ? 'unavailable' : 'loading',
        currentTime: null,
        duration: null,
        controllable: false,
      };
      playbackRef.current = nextPlayback;
      playbackSampleRef.current = null;
      resetTimeline();
      sourceStartRef.current = parsedSource.kind === 'embed' ? null : parsedSource.startSeconds;
      changeStopAt(plannedStop !== null ? plannedStopText.trim() : '');
      restoreLookMode();
      sourceRef.current = parsedSource;
      const savedNotes = loadStoredNotes(parsedSource);
      notesRef.current = savedNotes;
      setNotes(savedNotes);
      setNoteDraft('');
      setNotesMessage('');
      setSource(parsedSource);
      setMediaMetadata(nextMetadata);
      mediaMetadataRef.current = nextMetadata;
      setError('');
      setReactions([]);
      setReactionMenuOpen(false);
      pendingSignalsRef.current = [];
      setPlaybackStatus(nextPlayback.status);
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : 'Unable to open this link.');
    }
  }

  function reset() {
    controllerRef.current = null;
    pendingSignalsRef.current = [];
    releaseObservation({ reason: 'cancelled' });
    setSource(null);
    setMediaMetadata(null);
    mediaMetadataRef.current = null;
    playbackRef.current = EMPTY_PLAYBACK;
    playbackSampleRef.current = null;
    resetTimeline();
    sourceStartRef.current = null;
    sourceRef.current = null;
    notesRef.current = [];
    setNotes([]);
    changeStopAt('');
    setPlaybackStatus('idle');
    setReactions([]);
    setReactionMenuOpen(false);
    setError('');
  }

  if (!source) {
    return (
      <main className="start-screen">
        <section className="start-content" aria-labelledby="page-title">
          <p className="eyebrow">Watch with GPT</p>
          <h1 id="page-title">Watch something together.</h1>
          <form className="link-form" id="link-form" onSubmit={submit}>
            <label className="sr-only" htmlFor="video-url">
              Video link
            </label>
            <input
              id="video-url"
              type="url"
              value={videoUrl}
              onChange={(event) => setVideoUrl(event.target.value)}
              placeholder="Paste a video link"
              autoComplete="url"
              autoFocus
              aria-describedby={error ? 'video-error' : 'video-support'}
              aria-invalid={Boolean(error)}
              required
            />
            <button type="submit" aria-label="Open video" disabled={!videoUrl.trim()}>
              <span aria-hidden="true">→</span>
            </button>
          </form>
          <div className="planned-times">
            <label className="time-field">
              <span>Start at</span>
              <input
                form="link-form"
                type="text"
                value={plannedStartText}
                onChange={(event) => setPlannedStartText(event.target.value)}
                placeholder="from link"
                aria-invalid={Boolean(plannedStartText.trim()) && parseTimeInput(plannedStartText) === null}
                title="Optional. Overrides any t= in the link, e.g. 1:00:00 or 45m"
              />
            </label>
            <label className="time-field">
              <span>Stop at</span>
              <input
                form="link-form"
                type="text"
                value={plannedStopText}
                onChange={(event) => setPlannedStopText(event.target.value)}
                placeholder="h:mm:ss"
                aria-invalid={Boolean(plannedStopText.trim()) && parseTimeInput(plannedStopText) === null}
                title="Optional. Pause automatically at this time, e.g. 2:00:00 or 90m"
              />
            </label>
          </div>
          {error ? (
            <p className="input-message input-error" id="video-error" role="alert">
              {error}
            </p>
          ) : (
            <p className="input-message" id="video-support">
              YouTube, a direct video file, or an embeddable player.
            </p>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="watch-screen" data-notes-open={notesOpen}>
      <header className="watch-header">
        <button type="button" className="wordmark" onClick={reset}>
          Watch with GPT
        </button>
        <div className="watch-header-actions">
          <button
            type="button"
            className="change-video"
            aria-expanded={notesOpen}
            aria-controls="notes-panel"
            onClick={() => setNotesOpen((open) => !open)}
          >
            {notesOpen ? 'Hide notes' : `Notes${notes.length ? ` (${notes.length})` : ''}`}
          </button>
          <button type="button" className="change-video" onClick={reset}>
            Change video
          </button>
        </div>
      </header>

      <div className="watch-body">
        <section className="watch-stage" aria-label="Shared video">
          <div className="player-frame">
            <PlayerSurface
              source={source}
              controllerRef={controllerRef}
              onPlayback={updatePlayback}
            />
            {captureBadge ? (
              <span className="capture-badge" aria-hidden="true">
                #{captureBadge.seq} · {captureBadge.timecode}
              </span>
            ) : null}
            <div className="reaction-layer" aria-live="polite" aria-atomic="false">
              {reactions.map((reaction) => (
                <span
                  key={reaction.id}
                  className="floating-reaction"
                  data-source={reaction.source}
                  style={{ left: `${reaction.left}%` }}
                >
                  {reaction.emoji}
                </span>
              ))}
            </div>
          </div>

          <div className="watch-controls">
            <div className="reaction-picker-shell" ref={reactionMenuRef}>
              <div className="reaction-picker" aria-label="React to this moment">
                {PRIMARY_REACTION_EMOJIS.map((emoji) => (
                  <button
                    type="button"
                    key={emoji}
                    className="reaction-button"
                    aria-label={`React with ${emoji}`}
                    disabled={viewerReactionCoolingDown}
                    onClick={() => publishUserReaction(emoji)}
                  >
                    {emoji}
                  </button>
                ))}
                <button
                  type="button"
                  className="reaction-button more-reactions-button"
                  aria-label={reactionMenuOpen ? 'Close more reactions' : 'Show more reactions'}
                  aria-expanded={reactionMenuOpen}
                  aria-controls="more-reactions"
                  onClick={() => setReactionMenuOpen((open) => !open)}
                >
                  <span aria-hidden="true">…</span>
                </button>
              </div>

              {reactionMenuOpen ? (
                <div
                  className="reaction-popover"
                  id="more-reactions"
                  role="dialog"
                  aria-label="More reactions"
                >
                  <div className="reaction-popover-header">
                    <span>Reactions</span>
                    <button
                      type="button"
                      className="reaction-popover-close"
                      aria-label="Close reactions"
                      onClick={() => setReactionMenuOpen(false)}
                    >
                      ×
                    </button>
                  </div>
                  <div className="reaction-grid">
                    {REACTION_EMOJIS.map((emoji) => (
                      <button
                        type="button"
                        key={emoji}
                        className="reaction-button"
                        aria-label={`React with ${emoji}`}
                        disabled={viewerReactionCoolingDown}
                        onClick={() => publishUserReaction(emoji)}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <span className="sr-only" aria-live="polite">
                {viewerReactionCoolingDown ? 'You can react again in three seconds.' : ''}
              </span>
            </div>

            <div className="observation-picker" aria-label="When GPT looks at the video">
              <span>Look</span>
              <button
                type="button"
                className="interval-button"
                data-active={lookMode === 'request'}
                aria-pressed={lookMode === 'request'}
                title="Only when you press Look now, send an emoji, or ask out loud"
                onClick={() => changeLookMode('request')}
              >
                On request
              </button>
              <button
                type="button"
                className="interval-button"
                data-active={lookMode === 'moments'}
                aria-pressed={lookMode === 'moments'}
                title={`On request, after you jump to a new spot, and every ${KEY_MOMENT_FALLBACK_SECONDS}s as a fallback`}
                onClick={() => changeLookMode('moments')}
              >
                Key moments
              </button>
              {OBSERVATION_INTERVALS_SECONDS.map((seconds) => {
                const active = lookMode === 'interval' && seconds === observationIntervalSeconds;
                return (
                  <button
                    type="button"
                    key={seconds}
                    className="interval-button"
                    data-active={active}
                    aria-pressed={active}
                    title={`Every ${seconds} seconds of playback`}
                    onClick={() => changeLookMode('interval', seconds)}
                  >
                    {seconds}s
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              className="look-now-button"
              onClick={() => publishUserSignal('look')}
              title="Ask GPT to look at the current frame"
            >
              Look now
            </button>
            {source.kind !== 'embed' ? (
              <button
                type="button"
                className="look-now-button"
                onClick={markMoment}
                title="Save a note at this moment and ask GPT to describe it"
              >
                Mark
              </button>
            ) : null}

            {source.kind !== 'embed' ? (
              <label className="time-field">
                <span>Stop at</span>
                <input
                  type="text"
                  value={stopAtText}
                  onChange={(event) => changeStopAt(event.target.value)}
                  placeholder="h:mm:ss"
                  aria-invalid={Boolean(stopAtText.trim()) && stopAtSeconds === null}
                  title="Pause automatically at this time, e.g. 1:00:00 or 45m"
                />
              </label>
            ) : null}
          </div>

          {source.kind === 'embed' ? (
            <p className="player-note">
              This player is shown as provided. Shared timing and playback controls may be unavailable.
            </p>
          ) : (
            <p className="player-note" data-playback-status={playbackStatus}>
              {playbackStatus === 'playing' ? 'Playing together' : 'Ready when you are'}
              {source.startSeconds ? ` · starts at ${formatTimecode(source.startSeconds)?.slice(0, -2)}` : ''}
              {stopAtSeconds !== null ? ` · pauses at ${formatTimecode(stopAtSeconds)?.slice(0, -2)}` : ''}
            </p>
          )}
          {source.kind !== 'embed' && (observerStatus.waiting || observerStatus.last) ? (
            <p className="player-note observer-status">
              {observerStatus.waiting
                ? 'GPT is following along'
                : statusNow - observerStatus.endedAt < OBSERVER_HEARTBEAT_MS + 15_000
                  ? 'GPT is responding'
                  : 'GPT is not following right now'}
              {observerStatus.last
                ? ` · last check #${observerStatus.last.seq} at ${observerStatus.last.timecode?.slice(0, -2) ?? '—'} (${WAKE_LABELS[observerStatus.last.reason]}${observerStatus.last.capture ? ', look requested' : ''})`
                : ''}
            </p>
          ) : null}
        </section>

        {notesOpen ? (
          <aside className="notes-panel" id="notes-panel" aria-label="Notes">
            <div className="notes-header">
              <h2>Notes</h2>
              <div className="notes-actions">
                <button type="button" onClick={copyNotes} disabled={notes.length === 0}>
                  Copy
                </button>
                <button type="button" onClick={downloadNotes} disabled={notes.length === 0}>
                  Download .md
                </button>
              </div>
            </div>

            {notes.length === 0 ? (
              <p className="notes-empty">
                Press Mark, type a note below, or say &ldquo;mark this&rdquo; to GPT. Notes save
                automatically for this video.
              </p>
            ) : (
              <ol className="notes-list">
                {[...notes]
                  .sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
                  .map((note) => {
                    const late = noteWrittenLateSeconds(note);
                    return (
                      <li key={note.id} className="note" data-source={note.source}>
                        <button
                          type="button"
                          className="note-time"
                          onClick={() => jumpToNote(note)}
                          disabled={note.time === null || source.kind === 'embed'}
                          title="Jump to this moment"
                        >
                          {shortTimecode(note.time)}
                        </button>
                        <div className="note-body">
                          <p className="note-text" data-pending={!note.text}>
                            {note.text ||
                              (note.source === 'mark' ? 'Marked. Waiting for GPT to describe it…' : '')}
                          </p>
                          <p className="note-meta">
                            {note.source === 'viewer' ? 'You' : note.source === 'mark' ? 'Your mark' : 'GPT'}
                            {note.source === 'mark' && note.text ? ', described by GPT' : ''}
                            {note.observationSeq !== null ? ` · check #${note.observationSeq}` : ''}
                            {late ? ` · written ${late}s later` : ''}
                          </p>
                        </div>
                        <button
                          type="button"
                          className="note-delete"
                          onClick={() => deleteNote(note.id)}
                          aria-label={`Delete note at ${shortTimecode(note.time)}`}
                        >
                          ×
                        </button>
                      </li>
                    );
                  })}
              </ol>
            )}

            <form className="note-form" onSubmit={addViewerNote}>
              <input
                type="text"
                value={noteDraft}
                onChange={(event) => setNoteDraft(event.target.value)}
                placeholder="Add a note at the current moment"
                maxLength={MAX_NOTE_LENGTH}
                aria-label="New note"
              />
              <button type="submit" disabled={!noteDraft.trim()}>
                Add
              </button>
            </form>
            {notesMessage ? <p className="notes-message">{notesMessage}</p> : null}
          </aside>
        ) : null}
      </div>
    </main>
  );
}
